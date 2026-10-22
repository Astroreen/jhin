import { cn } from "@jhin/ui";

import { lazyChunk } from "../../lib/lazy-chunk.tsx";
import { CHAT_MARKDOWN_CLASS, type ChatMarkdownProps } from "./markdown-style.ts";

/** The message's plain text in the markdown's box: while the renderer loads, or if it cannot. */
function PlainText(props: ChatMarkdownProps) {
  return (
    <div
      className={cn(CHAT_MARKDOWN_CLASS, "whitespace-pre-wrap", props.className)}
      data-streaming={props.streaming === true ? "" : undefined}
    >
      {props.text}
    </div>
  );
}

/**
 * A message's text: its markdown once the renderer (remark, GFM, Shiki), a
 * chunk of its own, has loaded with the first message; its plain text until then.
 */
export const MessageText = lazyChunk(
  () => import("./markdown.tsx").then((module) => module.ChatMarkdown),
  { loading: (props) => <PlainText {...props} />, failed: (props) => <PlainText {...props} /> },
);
