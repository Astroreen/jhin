// The rendering follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ChatMarkdown.tsx
// (a file chip's menu and ⌘/Ctrl-click from its MarkdownFileLink) and apps/web/src/editorLabels.ts.
import {
  type AgentSkill,
  type AssistantCitation,
  parseAssistantCitationHref,
  parseContextHref,
} from "@jhin/agent-api";
import type { EditorInfo } from "@jhin/host-api";
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  use,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { fileLinkPath, inlineSkillTokens } from "../../lib/composer-trigger.ts";
import { skillDisplayName } from "../../lib/composer-menu.ts";
import { highlight, languageOf } from "../../lib/highlight.ts";
import { useCopy } from "../../lib/hooks.ts";
import { MessageCitationChip } from "./citation-chips.tsx";
import { ContextRecordChip } from "./context-chips.tsx";
import { FileMentionChip, MessageSkillChip } from "./file-chips.tsx";
import { CHAT_MARKDOWN_CLASS, type ChatMarkdownProps } from "./markdown-style.ts";
import {
  type AgentFileLinks,
  AgentFileLinksContext,
  MessageContextChipsContext,
} from "./message-context.ts";
import {
  fileLinkLabel,
  formatWorkspaceRelativePath,
  inlineCodeFilePathCandidate,
  resolveMarkdownFileLinkTarget,
  resolvePathLinkTarget,
  shouldOpenFileLinkInEditor,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "../../lib/file-links.ts";
import { preferredEditor } from "../../lib/preferred-editor.ts";

/** The text of a React subtree (a code element's children). */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function CodeBlock({ code, fence }: { code: string; fence: string | undefined }) {
  const language = languageOf(fence);
  const [html, setHtml] = useState<string | undefined>();
  const [wrapped, setWrapped] = useState(false);
  const { copied, copy } = useCopy();
  useEffect(() => {
    if (language === undefined) {
      setHtml(undefined);
      return;
    }
    let current = true;
    // Streaming code changes with every delta: highlight what is there once a frame.
    const frame = requestAnimationFrame(() => {
      void highlight(code, language).then(
        (next) => current && setHtml(next),
        () => current && setHtml(undefined),
      );
    });
    return () => {
      current = false;
      cancelAnimationFrame(frame);
    };
  }, [code, language]);

  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={fence}
      data-wrap={wrapped}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
          <span className="truncate">{fence ?? "text"}</span>
        </span>
        <span aria-label="Code block actions" className="flex items-center gap-0.5" role="toolbar">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Wrap lines"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped(!wrapped)}
                  size="icon-xs"
                  variant={wrapped ? "secondary" : "ghost-muted"}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapped ? "Don't wrap lines" : "Wrap lines"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Copy code"
                  onClick={() => copy(code)}
                  size="icon-xs"
                  variant="ghost-muted"
                />
              }
            >
              {copied ? (
                <CheckIcon className="size-3 text-primary" />
              ) : (
                <CopyIcon className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{copied ? "Copied" : "Copy code"}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {html === undefined ? (
        <pre data-wrap={wrapped}>
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className={cn(
            "[&_pre]:overflow-x-auto [&_pre]:px-[0.9rem] [&_pre]:py-[0.8rem]",
            wrapped && "[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]",
          )}
          // Shiki escapes the code; the markup is its own.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

/** A heading whose text may hold skill chips (D1341). */
function heading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function Heading({
    children,
    node: _node,
    ...props
  }: ComponentProps<"h1"> & { node?: unknown }) {
    return (
      <Tag {...props}>
        <SkillChips>{children}</SkillChips>
      </Tag>
    );
  };
}

const COMPONENTS: Components = {
  pre({ children }) {
    const child = Children.toArray(children)[0];
    const element = isValidElement(child)
      ? (child as ReactElement<{ className?: string; children?: ReactNode }>)
      : undefined;
    const fence = /language-([\w+#.-]+)/.exec(element?.props.className ?? "")?.[1];
    const code = textOf(element?.props.children ?? children).replace(/\n$/, "");
    return <CodeBlock code={code} fence={fence} />;
  },
  a({ children, href, node: _node, ...props }) {
    const reference = typeof href === "string" ? parseContextHref(href) : null;
    if (reference !== null) return <ContextReference href={href!} label={textOf(children)} />;
    // A quote is the link labelled as T3 labels it, as the prompt and the agent's text read it.
    const citation =
      typeof href === "string" && textOf(children) === "Assistant quote"
        ? parseAssistantCitationHref(href)
        : null;
    if (citation !== null) return <CitationReference citation={citation} />;
    const link = (
      <a {...props} href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
    const path = typeof href === "string" ? fileLinkPath(textOf(children), href) : undefined;
    if (path !== undefined) return <FileReference fallback={link} href={href!} path={path} />;
    return typeof href === "string" ? <AgentFileLink fallback={link} href={href} /> : link;
  },
  code({ children, node: _node, ...props }) {
    // Inline code only: a fenced block is the `pre`'s, which renders it itself.
    const code = <code {...props}>{children}</code>;
    return typeof children === "string" ? <AgentFileCode code={children} fallback={code} /> : code;
  },
  p({ children, node: _node, ...props }) {
    return (
      <p {...props}>
        <SkillChips>{children}</SkillChips>
      </p>
    );
  },
  li({ children, node: _node, ...props }) {
    return (
      <li {...props}>
        <SkillChips>{children}</SkillChips>
      </li>
    );
  },
  td({ children, node: _node, ...props }) {
    return (
      <td {...props}>
        <SkillChips>{children}</SkillChips>
      </td>
    );
  },
  th({ children, node: _node, ...props }) {
    return (
      <th {...props}>
        <SkillChips>{children}</SkillChips>
      </th>
    );
  },
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  h5: heading("h5"),
  h6: heading("h6"),
  table({ children, node: _node, ...props }) {
    return (
      <div className="chat-markdown-table-container">
        <table {...props}>{children}</table>
      </div>
    );
  },
  img({ node: _node, alt, src, ...props }: ComponentProps<"img"> & { node?: unknown }) {
    // An agent's reply may carry text injected from elsewhere: an image from
    // another server would be fetched as it renders and could leak what its URL
    // holds. Only images inside the message show; others are links to open.
    if (typeof src !== "string" || !src.startsWith("data:image/")) {
      return (
        <a href={src} rel="noopener noreferrer" target="_blank">
          {alt === undefined || alt === "" ? "Image" : alt}
        </a>
      );
    }
    return (
      <img
        {...props}
        alt={alt ?? ""}
        className="h-auto max-h-[30rem] w-auto max-w-[min(100%,30rem)] rounded-lg border border-border/40 object-contain"
        loading="lazy"
        src={src}
      />
    );
  },
};

/** A message's context references (D1007) keep their `jhin-context:` links; others as before. */
function keepContextReferences(url: string): string {
  return parseContextHref(url) === null && parseAssistantCitationHref(url) === null
    ? defaultUrlTransform(url)
    : url;
}

/** A quote of an agent's message (D1011): its chip in a user message, its text elsewhere. */
function CitationReference(props: { citation: AssistantCitation }) {
  const chips = use(MessageContextChipsContext);
  if (chips === undefined) return <q>{props.citation.text}</q>;
  return (
    <MessageCitationChip citation={props.citation} showSource={chips.actions.showCitationSource} />
  );
}

/** A `jhin-context://` reference: its record's chip, or its label outside a user message. */
function ContextReference(props: { href: string; label: string }) {
  const chips = use(MessageContextChipsContext);
  if (chips === undefined) return <span>{props.label}</span>;
  const reference = parseContextHref(props.href);
  return (
    <ContextRecordChip
      actions={chips.actions}
      href={props.href}
      label={props.label}
      record={reference === null ? undefined : chips.records.get(reference.contextId)}
      unavailable="This context is no longer available."
    />
  );
}

/**
 * A file link of a user message (D1341): its chip; in an agent's message the agent's chip
 * (D1431), elsewhere the link as before.
 */
function FileReference(props: { path: string; href: string; fallback: ReactNode }) {
  const chips = use(MessageContextChipsContext);
  if (chips === undefined) return <AgentFileLink fallback={props.fallback} href={props.href} />;
  return <FileMentionChip onPreview={chips.previewFile} path={props.path} />;
}

/** Where an agent's link names a file of the thread's folder (T3's `MarkdownFileLinkMeta`). */
interface AgentFileTarget {
  /** Relative to the thread's folder, as the right panel and the editors read it. */
  readonly path: string;
  /** The absolute path, without a position: what the parent suffixes are keyed by. */
  readonly filePath: string;
  /** The absolute path with its position: "Copy full path". */
  readonly targetPath: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * Where an agent's link or inline code names a file of the thread's folder: its path there, its
 * line and column (T3's `resolveMarkdownFileLinkMeta`); undefined for anything else.
 */
function agentFileTarget(absolute: string | null, root: string): AgentFileTarget | undefined {
  if (absolute === null) return undefined;
  const { path, line, column } = splitFilePathPosition(absolute);
  const relative = workspaceRelativeFilePath(path, root);
  if (relative === null || relative === ".") return undefined;
  return {
    path: relative,
    filePath: path,
    targetPath: absolute,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

/** T3's `openInEditorMenuLabel`. */
function openInEditorMenuLabel(editor: EditorInfo | undefined): string {
  return editor === undefined || editor.id === "file-manager"
    ? "Open in editor"
    : `Open in ${editor.label}`;
}

/**
 * T3's MarkdownFileLink in an agent's message (D1431, D1643): its chip opens the file at its line
 * in the right panel, ⌘/Ctrl-click in the editor last chosen; its menu opens it there or copies
 * its path.
 */
function AgentFileChip(props: { target: AgentFileTarget; links: AgentFileLinks }) {
  const { target, links } = props;
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined);
  // One anchor per opened menu: a new one each render would move the menu each time.
  const anchor = useMemo(
    () =>
      menu === undefined
        ? undefined
        : {
            getBoundingClientRect: () =>
              DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
          },
    [menu],
  );
  const editors = links.editors.filter((editor) => editor.id !== "file-manager");
  const openInEditor =
    links.openInEditor === undefined || editors.length === 0
      ? undefined
      : () => {
          // Read when used: the editor chosen last may have changed since the chip rendered.
          const editor = preferredEditor(editors);
          if (editor === undefined) return;
          links.openInEditor?.(target.path, editor, {
            ...(target.line === undefined ? {} : { line: target.line }),
            ...(target.column === undefined ? {} : { column: target.column }),
          });
        };
  return (
    <>
      <FileMentionChip
        label={fileLinkLabel(
          {
            path: target.filePath,
            ...(target.line === undefined ? {} : { line: target.line }),
            ...(target.column === undefined ? {} : { column: target.column }),
          },
          links.parentSuffixes,
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // From the keyboard the event has no pointer: the menu opens under the chip.
          if (event.clientX === 0 && event.clientY === 0) {
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({ x: bounds.left, y: bounds.bottom });
          } else {
            setMenu({ x: event.clientX, y: event.clientY });
          }
        }}
        onPreview={(path, event) => {
          if (openInEditor !== undefined && shouldOpenFileLinkInEditor(event)) {
            openInEditor();
            return;
          }
          links.open(path, target.line);
        }}
        path={target.path}
      />
      <Menu
        onOpenChange={(open) => {
          if (!open) setMenu(undefined);
        }}
        open={menu !== undefined}
      >
        {menu === undefined ? null : (
          <MenuPopup align="start" anchor={anchor} side="bottom" sideOffset={2}>
            {openInEditor === undefined ? null : (
              <MenuItem onClick={openInEditor}>
                {openInEditorMenuLabel(preferredEditor(editors))}
              </MenuItem>
            )}
            {links.copyPath === undefined ? null : (
              <>
                <MenuItem
                  onClick={() =>
                    links.copyPath?.(
                      formatWorkspaceRelativePath(target.targetPath, links.workspaceRoot),
                      "Relative path",
                    )
                  }
                >
                  Copy relative path
                </MenuItem>
                <MenuItem onClick={() => links.copyPath?.(target.targetPath, "Full path")}>
                  Copy full path
                </MenuItem>
              </>
            )}
          </MenuPopup>
        )}
      </Menu>
    </>
  );
}

function AgentFileLink(props: { href: string; fallback: ReactNode }) {
  const links = use(AgentFileLinksContext);
  if (links === undefined) return props.fallback;
  const target = agentFileTarget(
    resolveMarkdownFileLinkTarget(props.href, links.workspaceRoot),
    links.workspaceRoot,
  );
  return target === undefined ? props.fallback : <AgentFileChip links={links} target={target} />;
}

function AgentFileCode(props: { code: string; fallback: ReactNode }) {
  const links = use(AgentFileLinksContext);
  if (links === undefined) return props.fallback;
  const candidate = inlineCodeFilePathCandidate(props.code);
  if (candidate === null) return props.fallback;
  const target = agentFileTarget(
    resolvePathLinkTarget(candidate, links.workspaceRoot),
    links.workspaceRoot,
  );
  return target === undefined ? props.fallback : <AgentFileChip links={links} target={target} />;
}

/** The `$name`s of the agent's skills in a user message's text, as T3's `SkillInlineText`. */
function skillChipsOf(text: string, skills: readonly AgentSkill[]): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const token of inlineSkillTokens(text)) {
    const skill = skills.find((candidate) => candidate.name === token.name);
    if (skill === undefined) continue;
    if (token.start > cursor) nodes.push(text.slice(cursor, token.start));
    nodes.push(<MessageSkillChip key={token.start} label={skillDisplayName(skill)} />);
    cursor = token.end;
  }
  if (cursor === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * T3's `renderSkillInlineMarkdownChildren`: the text of a block and of its inline marks, never of
 * code or of a link.
 */
function withSkillChips(children: ReactNode, skills: readonly AgentSkill[]): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return skillChipsOf(child, skills);
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    const tag = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (tag === "code" || tag === "a" || !("children" in child.props)) return child;
    return cloneElement(child, undefined, withSkillChips(child.props.children, skills));
  });
}

function SkillChips(props: { children: ReactNode }) {
  const skills = use(MessageContextChipsContext)?.skills;
  if (skills === undefined || skills.length === 0) return props.children;
  return withSkillChips(props.children, skills);
}

const PLUGINS = [remarkGfm];
const PLUGINS_WITH_BREAKS = [remarkGfm, remarkBreaks];

/** Markdown of a message: GitHub-flavoured, code highlighted, links opening elsewhere. */
export function ChatMarkdown(props: ChatMarkdownProps) {
  return (
    <div
      className={cn(CHAT_MARKDOWN_CLASS, props.className)}
      data-streaming={props.streaming === true ? "" : undefined}
    >
      <ReactMarkdown
        components={COMPONENTS}
        urlTransform={keepContextReferences}
        remarkPlugins={props.lineBreaks === true ? PLUGINS_WITH_BREAKS : PLUGINS}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
