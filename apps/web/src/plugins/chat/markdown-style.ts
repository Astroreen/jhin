export interface ChatMarkdownProps {
  text: string;
  streaming?: boolean;
  /** Single newlines break lines, as typed (user messages). */
  lineBreaks?: boolean;
  className?: string;
}

export const CHAT_MARKDOWN_CLASS =
  "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]";
