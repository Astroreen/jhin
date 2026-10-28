export interface ChatMarkdownProps {
  text: string;
  streaming?: boolean;
  /** Single newlines break lines, as typed (user messages). */
  lineBreaks?: boolean;
  className?: string;
  /**
   * T3's `onTaskListChange` (t3-parity.md D1648): a task box ticked, where its `[ ]` is in `text`;
   * without it the boxes stay disabled.
   */
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
}

export const CHAT_MARKDOWN_CLASS =
  "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]";
