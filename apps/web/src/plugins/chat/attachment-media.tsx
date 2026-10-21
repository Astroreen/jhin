// Reading attachments back from a thread's node, and the lazily loaded attachment views (D440).
import type { StoredAttachment, TurnAttachment } from "@jhin/agent-api";
import { targetKey, type NodeTarget } from "@jhin/client-api";
import { createContext, useEffect, useMemo, useState } from "react";

import { lazyChunk } from "../../lib/lazy-chunk.tsx";
import { downloadAttachment, readAttachmentHead } from "../../lib/uploads.ts";
import { useChat } from "./services.ts";

/** Reads attachments back from the node a thread is on. */
export interface AttachmentLoader {
  /** The whole attachment as an object URL, read once for the page. */
  url(attachment: StoredAttachment): Promise<string>;
  /** Its first `length` bytes (at most 1 MiB), and whether they are all of it. */
  head(attachment: StoredAttachment, length: number): Promise<{ bytes: Uint8Array; done: boolean }>;
}

/** The attachments of `target`'s node, read through its `attachments.read`. */
export function useAttachmentLoader(target: NodeTarget): AttachmentLoader {
  const chat = useChat();
  const key = targetKey(target);
  return useMemo(() => {
    const call = <T,>(method: string, params: unknown) =>
      chat.threads.call<T>(target, method, params);
    return {
      url: (attachment) =>
        chat.attachmentUrls.load(`${key}|${attachment.id}`, () =>
          downloadAttachment(call, attachment.id),
        ),
      head: (attachment, length) => readAttachmentHead(call, attachment.id, length),
    };
  }, [chat, key]);
}

/**
 * The loader of the thread's node; absent where the timeline shows no node's
 * thread (a test, a preview).
 */
export const AttachmentLoaderContext = createContext<AttachmentLoader | undefined>(undefined);

/**
 * An attachment's object URL once loaded, or undefined while it loads, when it
 * cannot, or until `enabled` (a video waits until it is in view).
 */
export function useAttachmentUrl(
  attachment: TurnAttachment | undefined,
  loader: AttachmentLoader | undefined,
  enabled = true,
): string | undefined {
  const inline =
    attachment !== undefined && "dataUrl" in attachment ? attachment.dataUrl : undefined;
  const [url, setUrl] = useState<string | undefined>(inline);
  const id = attachment !== undefined && "id" in attachment ? attachment.id : undefined;
  useEffect(() => {
    if (
      !enabled ||
      inline !== undefined ||
      loader === undefined ||
      attachment === undefined ||
      !("id" in attachment)
    )
      return;
    let current = true;
    loader.url(attachment).then(
      (loaded) => current && setUrl(loaded),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id, inline, loader, enabled]);
  return url;
}

/** T3's file preview in a dialog, a chunk of its own (D440). */
export const AttachmentPreviewDialog = lazyChunk(
  () => import("./attachment-preview.tsx").then((module) => module.AttachmentPreviewDialog),
  { loading: () => null, failed: () => null },
);

/** A video played full size, in the same chunk. */
export const VideoPreviewDialog = lazyChunk(
  () => import("./attachment-preview.tsx").then((module) => module.VideoPreviewDialog),
  { loading: () => null, failed: () => null },
);
