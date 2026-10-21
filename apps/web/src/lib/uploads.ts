// Uploads follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/attachmentUploadQueue.ts
// at eb7b35ac (an upload starts when a file is attached and reports its progress). T3 POSTs the
// file to a signed URL; here it goes in chunks through the node's `attachments.*` commands (D292).
import type { StoredAttachment } from "@jhin/agent-api";

/** Calls a command on the node the composer sends to. */
export type NodeCall = <T>(method: string, params: unknown) => Promise<T>;

/** One chunk of an upload: the node takes at most 1 MiB. */
const CHUNK_BYTES = 768 * 1024;

const MIB = 1024 * 1024;
/** T3's limits (`chatAttachment.ts`), checked before uploading; the node checks them again. */
export const ATTACHMENT_LIMITS = {
  count: 100,
  imageBytes: 10 * MIB,
  totalImageBytes: 80 * MIB,
  fileBytes: 50 * MIB,
} as const;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Uploads `file` to the node in chunks and resolves with the attachment as a
 * message names it. `onProgress` gets the share sent so far (0 to 1).
 */
export async function uploadAttachment(
  call: NodeCall,
  file: Blob & { readonly name: string },
  kind: "image" | "file",
  onProgress: (progress: number) => void = () => {},
  signal?: AbortSignal,
): Promise<StoredAttachment> {
  const mimeType = file.type || "application/octet-stream";
  const { attachmentId } = await call<{ attachmentId: string }>("attachments.begin", {
    kind,
    name: file.name,
    mimeType,
    sizeBytes: file.size,
  });
  let offset = 0;
  while (offset < file.size) {
    if (signal?.aborted) throw new Error("Upload cancelled");
    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    const { received } = await call<{ received: number }>("attachments.write", {
      attachmentId,
      offset,
      data: bytesToBase64(chunk),
    });
    offset = received;
    onProgress(file.size === 0 ? 1 : offset / file.size);
  }
  return { kind, id: attachmentId, name: file.name, mimeType, sizeBytes: file.size };
}

/** Reads an attachment back from the node, chunk by chunk. */
export async function downloadAttachment(call: NodeCall, attachmentId: string): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let mimeType = "application/octet-stream";
  for (;;) {
    const chunk = await call<{ data: string; done: boolean; mimeType: string }>(
      "attachments.read",
      { attachmentId, offset },
    );
    mimeType = chunk.mimeType;
    const bytes = base64ToBytes(chunk.data);
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.done || bytes.length === 0) break;
  }
  return new Blob(parts as BlobPart[], { type: mimeType });
}

/**
 * Reads the first `length` bytes of an attachment (at most 1 MiB, one
 * call), and whether they are all of it: a text preview needs no more.
 */
export async function readAttachmentHead(
  call: NodeCall,
  attachmentId: string,
  length: number,
): Promise<{ bytes: Uint8Array; done: boolean }> {
  const chunk = await call<{ data: string; done: boolean }>("attachments.read", {
    attachmentId,
    offset: 0,
    length,
  });
  return { bytes: base64ToBytes(chunk.data), done: chunk.done };
}

/**
 * Object URLs of attachments read from their nodes, one load per attachment
 * however many views show it. Kept for the page's life: an attachment never
 * changes once sent.
 */
export function createAttachmentUrls() {
  const urls = new Map<string, Promise<string>>();
  return {
    load(key: string, read: () => Promise<Blob>): Promise<string> {
      let url = urls.get(key);
      if (url === undefined) {
        url = read().then((blob) => URL.createObjectURL(blob));
        // A failed read is tried again next time.
        url.catch(() => urls.delete(key));
        urls.set(key, url);
      }
      return url;
    },
    dispose() {
      for (const url of urls.values()) void url.then(URL.revokeObjectURL, () => undefined);
      urls.clear();
    },
  };
}

export type AttachmentUrls = ReturnType<typeof createAttachmentUrls>;
