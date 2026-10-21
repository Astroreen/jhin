// Attaching files follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// apps/web/src/components/chat/ChatComposer.tsx (addComposerAttachments, the attachment
// rows and thumbnails, large pastes as pasted-text.txt). Their views are in attachment-views.tsx.
import type { StoredAttachment, TurnAttachment } from "@jhin/agent-api";
import type { Toasts } from "@jhin/ui";
import { useEffect, useRef, useState } from "react";

import {
  classifyAttachmentFile,
  fileAttachmentTooLargeMessage,
  normalizeImageFileMimeType,
} from "../../lib/attachment-files.ts";
import { fitAttachments, type DraftAttachment } from "../../lib/composer.ts";
import { videoMimeType } from "../../lib/file-preview.ts";
import { lazyChunk } from "../../lib/lazy-chunk.tsx";
/** Image compression loads with the first image attached, not with the page (D440). */
const imageCompression = () => import("../../lib/image-compression.ts");
import { ATTACHMENT_LIMITS, uploadAttachment, type NodeCall } from "../../lib/uploads.ts";
import type { AttachmentLoader } from "./attachment-media.tsx";

/** An attachment in the composer: uploading, uploaded, or failed. */
export interface ComposerAttachment {
  readonly localId: string;
  readonly kind: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** A thumbnail of an image (a small data URL). */
  readonly previewUrl?: string;
  readonly status: "uploading" | "ready" | "failed";
  /** Share uploaded, 0 to 1. */
  readonly progress: number;
  readonly stored?: StoredAttachment;
  readonly error?: string;
}

/** What the attachments above the prompt show and do. */
export interface ComposerAttachmentsProps {
  readonly items: readonly ComposerAttachment[];
  /** The picked file of an item, while the composer has it. */
  fileOf(localId: string): File | undefined;
  /** Reads an uploaded item back from the node (a draft restored after a reload). */
  readonly loader: AttachmentLoader | undefined;
  onRemove(localId: string): void;
  onRetry(localId: string): void;
}

const fromDraft = (item: DraftAttachment): ComposerAttachment => ({
  localId: item.id,
  kind: item.kind,
  name: item.name,
  mimeType: item.mimeType,
  sizeBytes: item.sizeBytes,
  ...(item.previewUrl === undefined ? {} : { previewUrl: item.previewUrl }),
  status: "ready",
  progress: 1,
  stored: {
    kind: item.kind,
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
  },
});

/**
 * The attachments of a message (a queued one being edited) as composer items:
 * those uploaded to the node; a data URL of D54 has no upload to keep.
 */
export function attachmentItems(attachments: readonly TurnAttachment[]): ComposerAttachment[] {
  return attachments.flatMap((item) => ("id" in item ? [fromDraft(item)] : []));
}

/** What a draft keeps: the uploaded attachments, by id, with their thumbnails. */
export function draftAttachments(items: readonly ComposerAttachment[]): DraftAttachment[] {
  return items.flatMap((item) =>
    item.stored === undefined
      ? []
      : [
          {
            ...item.stored,
            ...(item.previewUrl === undefined ? {} : { previewUrl: item.previewUrl }),
          },
        ],
  );
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "Upload failed");

/**
 * The composer's attachments (D295, D296): files are checked, images made to
 * fit, and each upload starts as soon as it is attached.
 */
export function useComposerAttachments(options: {
  readonly call: NodeCall;
  readonly toasts: Toasts | undefined;
  readonly initial: readonly DraftAttachment[] | undefined;
}) {
  const { call, toasts } = options;
  const [items, setItems] = useState<readonly ComposerAttachment[]>(() =>
    (options.initial ?? []).filter((item) => "id" in item).map(fromDraft),
  );
  const files = useRef(new Map<string, File>());
  const current = useRef(items);
  current.current = items;
  // Uploads of a composer that went away keep nothing alive.
  const aborts = useRef(new Map<string, AbortController>());
  useEffect(
    () => () => {
      for (const controller of aborts.current.values()) controller.abort();
    },
    [],
  );

  const update = (localId: string, change: Partial<ComposerAttachment>) =>
    setItems((list) =>
      list.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
    );

  const upload = (item: ComposerAttachment) => {
    const file = files.current.get(item.localId);
    if (file === undefined) return;
    const controller = new AbortController();
    aborts.current.set(item.localId, controller);
    update(item.localId, { status: "uploading", progress: 0 });
    uploadAttachment(
      call,
      file,
      item.kind,
      (progress) => update(item.localId, { progress }),
      controller.signal,
    ).then(
      (stored) => {
        aborts.current.delete(item.localId);
        // Removed meanwhile: the node forgets it too.
        if (!current.current.some((candidate) => candidate.localId === item.localId)) {
          void call("attachments.discard", { attachmentId: stored.id }).catch(() => undefined);
          return;
        }
        update(item.localId, { status: "ready", progress: 1, stored });
      },
      (error: unknown) => {
        aborts.current.delete(item.localId);
        if (controller.signal.aborted) return;
        update(item.localId, { status: "failed", error: errorText(error) });
      },
    );
  };

  /** T3's addComposerAttachments: what cannot be attached says why. */
  const add = async (picked: readonly File[]) => {
    const error = (title: string, description?: string) =>
      toasts?.show({ type: "error", title, ...(description === undefined ? {} : { description }) });
    const prepared: { item: ComposerAttachment; file: File }[] = [];
    for (const original of picked) {
      const classification = classifyAttachmentFile(original);
      if (classification === "unsupported-image") {
        error(
          `'${original.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`,
        );
        continue;
      }
      if (original.size === 0) {
        error(`'${original.name}' is empty or could not be read.`);
        continue;
      }
      let file = original;
      if (classification === "image") {
        const { prepareImageForAttachment } = await imageCompression();
        const result = await prepareImageForAttachment(
          normalizeImageFileMimeType(original),
          ATTACHMENT_LIMITS.imageBytes,
        );
        if (!result.ok) {
          error(
            result.reason === "too-large"
              ? `'${original.name}' is too large to attach, even after compression.`
              : `'${original.name}' could not be read as an image.`,
          );
          continue;
        }
        file = result.file;
      } else if (file.size > ATTACHMENT_LIMITS.fileBytes) {
        error(fileAttachmentTooLargeMessage(file.name, ATTACHMENT_LIMITS.fileBytes));
        continue;
      } else {
        // A video without a type (or a generic one) is typed by its name, as T3 does.
        const video = videoMimeType({ name: file.name, mimeType: file.type });
        if (video !== null && video !== file.type) {
          file = new File([file], file.name, { type: video, lastModified: file.lastModified });
        }
      }
      const kind = classification === "image" ? "image" : "file";
      const previewUrl =
        kind === "image"
          ? await imageCompression()
              .then(({ createComposerImageThumbnail }) => createComposerImageThumbnail(file))
              .catch(() => null)
          : null;
      prepared.push({
        file,
        item: {
          localId: crypto.randomUUID(),
          kind,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          ...(previewUrl === null ? {} : { previewUrl }),
          status: "uploading",
          progress: 0,
        },
      });
    }
    // What fits in one message (T3's limits), from the latest list.
    const { kept, dropped } = fitAttachments(
      current.current,
      prepared.map((entry) => entry.item),
    );
    if (dropped.length > 0) {
      error(
        kept.length >= ATTACHMENT_LIMITS.count
          ? "You can attach up to 100 files per message."
          : "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.",
      );
    }
    const added = prepared.filter((entry) => !dropped.includes(entry.item));
    for (const entry of added) files.current.set(entry.item.localId, entry.file);
    current.current = [...current.current, ...added.map((entry) => entry.item)];
    setItems(current.current);
    for (const entry of added) upload(entry.item);
  };

  const remove = (localId: string) => {
    const item = current.current.find((candidate) => candidate.localId === localId);
    aborts.current.get(localId)?.abort();
    files.current.delete(localId);
    current.current = current.current.filter((candidate) => candidate.localId !== localId);
    setItems(current.current);
    if (item?.stored !== undefined) {
      void call("attachments.discard", { attachmentId: item.stored.id }).catch(() => undefined);
    }
  };

  const retry = (localId: string) => {
    const item = current.current.find((candidate) => candidate.localId === localId);
    if (item !== undefined && item.status === "failed") upload(item);
  };

  /**
   * The attachments a message sends, or why it cannot go yet (T3's
   * "Attachment 'X' did not finish uploading.").
   */
  const forMessage = ():
    | { ok: true; attachments: TurnAttachment[] }
    | { ok: false; message: string } => {
    const waiting = current.current.find((item) => item.stored === undefined);
    if (waiting !== undefined) {
      return { ok: false, message: `Attachment '${waiting.name}' did not finish uploading.` };
    }
    return { ok: true, attachments: current.current.map((item) => item.stored!) };
  };

  /** Shows these items instead (an edit of a queued message, the draft it put aside). */
  const replace = (next: readonly ComposerAttachment[]) => {
    current.current = next;
    setItems(next);
  };

  /** Clears the list for a message on its way; `restore` puts it back if it fails. */
  const take = () => {
    const taken = current.current;
    current.current = [];
    setItems([]);
    return {
      restore() {
        current.current = [...taken, ...current.current];
        setItems(current.current);
      },
      sent() {
        for (const item of taken) files.current.delete(item.localId);
      },
    };
  };

  /** The file picked for an item, while this composer has it (a preview reads it locally). */
  const fileOf = (localId: string): File | undefined => files.current.get(localId);

  return { items, add, remove, retry, forMessage, take, replace, fileOf };
}

/** T3's attachments above the prompt, a chunk of its own loaded with the first one (D440). */
const ComposerAttachmentsView = lazyChunk(
  () => import("./attachment-views.tsx").then((module) => module.ComposerAttachments),
  { loading: () => null, failed: () => null },
);

export function ComposerAttachments(props: ComposerAttachmentsProps) {
  return props.items.length === 0 ? null : <ComposerAttachmentsView {...props} />;
}
