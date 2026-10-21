import type { ThreadTranscriptProps } from "@jhin/client-api";

import { CHAT_SECTION, ChatSettings, useSection } from "../../lib/settings.ts";
import { AttachmentLoaderContext, useAttachmentLoader } from "./attachment-media.tsx";
import { useChat } from "./services.ts";
import { useThreadTimeline } from "./thread-timeline.ts";
import { TimelineView } from "./timeline.tsx";

/**
 * A thread's conversation, read only (the `thread.transcript` slot, D614): the
 * timeline of the thread view without its composer, header or requests, for
 * threads that are observed rather than driven, such as an agent's generations.
 */
export function ThreadTranscript({ target, threadId }: ThreadTranscriptProps) {
  const chat = useChat();
  const settings = useSection(chat.context, CHAT_SECTION, ChatSettings);
  const { timeline, error } = useThreadTimeline(
    chat.threads,
    chat.connections,
    target,
    threadId,
  );
  const loadAttachment = useAttachmentLoader(target);
  if (error !== undefined) {
    return <p className="px-4 py-6 text-sm text-destructive-foreground">{error}</p>;
  }
  return (
    <div
      aria-label="Transcript"
      className="mx-auto w-full max-w-(--chat-content-max-width) px-4"
      role="log"
    >
      {/* A thread with no turns has no events to wait for: it says so at once. */}
      {timeline.turns.length === 0 ? (
        <p className="py-24 text-center text-sm text-muted-foreground">No turns yet.</p>
      ) : (
        <AttachmentLoaderContext.Provider value={loadAttachment}>
          <TimelineView format={settings.timestampFormat} timeline={timeline} />
        </AttachmentLoaderContext.Provider>
      )}
    </div>
  );
}
