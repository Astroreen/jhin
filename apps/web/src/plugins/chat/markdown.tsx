// The rendering follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ChatMarkdown.tsx.
import { Button, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";
import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { highlight, languageOf } from "../../lib/highlight.ts";
import { useCopy } from "../../lib/hooks.ts";

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
    return (
      <a {...props} href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
  },
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

const PLUGINS = [remarkGfm];
const PLUGINS_WITH_BREAKS = [remarkGfm, remarkBreaks];

/** Markdown of a message: GitHub-flavoured, code highlighted, links opening elsewhere. */
export function ChatMarkdown(props: {
  text: string;
  streaming?: boolean;
  /** Single newlines break lines, as typed (user messages). */
  lineBreaks?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]",
        props.className,
      )}
      data-streaming={props.streaming === true ? "" : undefined}
    >
      <ReactMarkdown
        components={COMPONENTS}
        remarkPlugins={props.lineBreaks === true ? PLUGINS_WITH_BREAKS : PLUGINS}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
