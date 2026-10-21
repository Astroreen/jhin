import type { StoredAttachment } from "@jhin/agent-api";
import { targetKey, type ThreadTranscriptProps } from "@jhin/client-api";
import { Spinner } from "@jhin/ui";
import { useCallback } from "react";

import { downloadAttachment } from "../../lib/uploads.ts";
import { CHAT_SECTION, ChatSettings, useSection } from "../../lib/settings.ts";
import { useChat } from "./services.ts";
import { useThreadTimeline } from "./thread-timeline.ts";
import { AttachmentLoaderContext, TimelineView } from "./timeline.tsx";

/**
 * A thread's conversation, read only (the `thread.transcript` slot, D614): the
 * timeline of the thread view without its composer, header or requests, for
 * threads that are observed rather than driven, such as an agent's generations.
 */
export function ThreadTranscript({ target, threadId }: ThreadTranscriptProps) {
  const chat = useChat();
  const settings = useSection(chat.context, CHAT_SECTION, ChatSettings);
  const { timeline, count, error } = useThreadTimeline(
    chat.threads,
    chat.connections,
    target,
    threadId,
  );
  const loadAttachment = useCallback(
    (attachment: StoredAttachment) =>
      chat.attachmentUrls.load(`${targetKey(target)}|${attachment.id}`, () =>
        downloadAttachment(
          (method, params) => chat.threads.call(target, method, params),
          attachment.id,
        ),
      ),
    [chat, targetKey(target)],
  );
  if (error !== undefined) {
    return <p className="px-4 py-6 text-sm text-destructive-foreground">{error}</p>;
  }
  if (count === 0 && timeline.turns.length === 0) {
    return (
      <div className="flex justify-center py-12">
        <Spinner tone="muted" />
      </div>
    );
  }
  return (
    <div
      aria-label="Transcript"
      className="mx-auto w-full max-w-(--chat-content-max-width) px-4"
      role="log"
    >
      <AttachmentLoaderContext.Provider value={loadAttachment}>
        <TimelineView
          format={settings.timestampFormat}
          thread={{ target, threadId }}
          timeline={timeline}
        />
      </AttachmentLoaderContext.Provider>
    </div>
  );
}
