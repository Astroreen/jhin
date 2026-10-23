// The rendering follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ChatMarkdown.tsx.
import {
  type AgentSkill,
  type AssistantCitation,
  parseAssistantCitationHref,
  parseContextHref,
} from "@jhin/agent-api";
import { Button, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  use,
  useEffect,
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
import { MessageContextChipsContext } from "./message-context.ts";

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
    return path === undefined ? link : <FileReference fallback={link} path={path} />;
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

/** A file link of a user message (D1341): its chip; elsewhere, the link as before. */
function FileReference(props: { path: string; fallback: ReactNode }) {
  const chips = use(MessageContextChipsContext);
  if (chips === undefined) return props.fallback;
  return <FileMentionChip onPreview={chips.previewFile} path={props.path} />;
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
