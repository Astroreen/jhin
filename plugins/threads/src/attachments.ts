// Limits, messages and the clean-up of uploads follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md)
// at eb7b35ac: packages/contracts/src/chatAttachment.ts, apps/server/src/assets/AttachmentUpload.ts
// and apps/server/src/attachmentStore.ts. T3 uploads through a signed HTTP URL; here the
// bytes come in chunks through commands, which a mesh relays like any other (D292).
import * as Crypto from "node:crypto";

import type { RuntimeAttachment, StoredAttachment, TurnAttachment } from "@jhin/agent-api";
import type { Commands } from "@jhin/sdk";
import { z } from "@jhin/sdk";
import type { BlobStore, Json, KeyValueStore } from "@jhin/storage-api";

const MIB = 1024 * 1024;
/** T3's PROVIDER_SEND_TURN_MAX_ATTACHMENTS. */
export const MAX_ATTACHMENTS = 100;
/** T3's PROVIDER_SEND_TURN_MAX_IMAGE_BYTES. */
const MAX_IMAGE_BYTES = 10 * MIB;
/** T3's PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES. */
const MAX_TOTAL_IMAGE_BYTES = 80 * MIB;
/** T3's PROVIDER_SEND_TURN_MAX_FILE_BYTES. */
const MAX_FILE_BYTES = 50 * MIB;
/** One chunk of an upload or a read, before base64. */
const MAX_CHUNK_BYTES = MIB;
/** Uploads not sent within this go (T3 sweeps its pending files after 24 h). */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** A sweep runs at most this often, when an upload begins (T3's 15 minutes). */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** The image types Claude and T3 take. */
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const BLOB_NAMESPACE = "jhin.threads.attachments";

const Meta = z.object({
  id: z.string(),
  kind: z.enum(["image", "file"]),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  createdAt: z.string(),
  /** The blob's key: `pending/<file>` until a message claims it, then `thread/<id>/<file>`. */
  key: z.string(),
  /** The thread whose message holds it, once claimed. */
  threadId: z.string().optional(),
});
type Meta = z.infer<typeof Meta>;

class AttachmentError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ATTACHMENT_ID = /^att-[0-9a-f-]{36}$/;

/** An attachment as `threads.send` takes it: by id (D293), or D54's data URL. */
export const AttachmentRef = z.object({
  kind: z.enum(["image", "file"]),
  id: z.string().regex(ATTACHMENT_ID, "must be an attachment id"),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().min(1),
});

/** A file name for the blob: the id, and an extension Claude and other tools can go by. */
function fileName(id: string, kind: "image" | "file", name: string, mimeType: string): string {
  if (kind === "image") {
    const ext = {
      "image/gif": "gif",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    }[mimeType];
    return `${id}.${ext ?? "bin"}`;
  }
  const ext = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase();
  return `${id}.${ext === undefined || ext === "part" ? "bin" : ext}`;
}

const megabytes = (bytes: number) => `${Math.round(bytes / MIB)} MB`;

/**
 * Uploads (`attachments.*`) and the attachments of messages: claimed by a
 * thread when it sends them, given to runtimes with their bytes and file, and
 * deleted with their thread. Without `storage.blobs` the node takes none.
 */
export function createAttachments(deps: {
  readonly kv: KeyValueStore;
  readonly blobs: BlobStore | undefined;
  readonly namespace: string;
  readonly now: () => Date;
  readonly queued: <T>(id: string, task: () => Promise<T>) => Promise<T>;
  readonly log: (message: string, data?: Record<string, unknown>) => void;
}) {
  const { kv, namespace, queued } = deps;
  let lastSweep = 0;

  const store = (): BlobStore => {
    if (deps.blobs === undefined) {
      throw new AttachmentError(
        "ATTACHMENTS_UNAVAILABLE",
        "This node does not support file attachments.",
      );
    }
    return deps.blobs;
  };
  const metaKey = (id: string) => `attachment/${id}`;
  const getMeta = async (id: string): Promise<Meta> => {
    const value = ATTACHMENT_ID.test(id) ? await kv.get(namespace, metaKey(id)) : undefined;
    const parsed = Meta.safeParse(value);
    if (!parsed.success) {
      throw new AttachmentError("ATTACHMENT_NOT_FOUND", "Attachment was not found.", {
        attachmentId: id,
      });
    }
    return parsed.data;
  };
  const remove = async (meta: Meta) => {
    await store().delete(BLOB_NAMESPACE, meta.key);
    await kv.delete(namespace, metaKey(meta.id));
  };

  /** Uploads that were never sent, older than a day. */
  async function sweep(): Promise<number> {
    if (deps.blobs === undefined) return 0;
    lastSweep = deps.now().getTime();
    let swept = 0;
    for (const entry of await kv.list(namespace, { prefix: "attachment/" })) {
      const parsed = Meta.safeParse(entry.value);
      if (!parsed.success || parsed.data.threadId !== undefined) continue;
      if (lastSweep - Date.parse(parsed.data.createdAt) < PENDING_TTL_MS) continue;
      await queued(entry.key, () => remove(parsed.data)).catch((error: unknown) =>
        deps.log("could not sweep an upload", {
          attachmentId: parsed.data.id,
          error: String(error),
        }),
      );
      swept += 1;
    }
    return swept;
  }

  function register(commands: Commands) {
    commands.register({
      name: "attachments.begin",
      description:
        "Starts an upload of a file to attach to a message; send its bytes with attachments.write, then name it in threads.send",
      input: z.object({
        kind: z.enum(["image", "file"]),
        name: z.string().trim().min(1).max(255),
        mimeType: z.string().trim().min(1).max(100),
        sizeBytes: z.number().int().min(1),
      }),
      output: z.object({ attachmentId: z.string() }),
      permissions: ["threads.write"],
      handler: async ({ kind, name, mimeType, sizeBytes }) => {
        store();
        if (kind === "image" && !IMAGE_MIME_TYPES.has(mimeType)) {
          throw new AttachmentError(
            "ATTACHMENT_TYPE",
            `'${name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`,
            { name, mimeType },
          );
        }
        const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (sizeBytes > limit) {
          throw new AttachmentError(
            "ATTACHMENT_TOO_LARGE",
            `'${name}' exceeds the ${megabytes(limit)} attachment limit.`,
            { name, sizeBytes, limit },
          );
        }
        if (deps.now().getTime() - lastSweep >= SWEEP_INTERVAL_MS) {
          void sweep().catch((error: unknown) =>
            deps.log("could not sweep uploads", { error: String(error) }),
          );
        }
        const id = `att-${Crypto.randomUUID()}`;
        const meta: Meta = {
          id,
          kind,
          name,
          mimeType,
          sizeBytes,
          createdAt: deps.now().toISOString(),
          key: `pending/${fileName(id, kind, name, mimeType)}`,
        };
        await kv.set(namespace, metaKey(id), meta as unknown as Json);
        return { attachmentId: id };
      },
    });

    commands.register({
      name: "attachments.write",
      description:
        "Sends the next chunk of an upload (base64, at most 1 MiB), at the offset received so far",
      input: z.object({
        attachmentId: z.string(),
        offset: z.number().int().min(0),
        data: z.string().max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4),
      }),
      output: z.object({ received: z.number(), complete: z.boolean() }),
      permissions: ["threads.write"],
      handler: ({ attachmentId, offset, data }) =>
        queued(metaKey(attachmentId), async () => {
          const blobs = store();
          const meta = await getMeta(attachmentId);
          if (meta.threadId !== undefined) {
            throw new AttachmentError("ATTACHMENT_SENT", "The attachment was already sent.", {
              attachmentId,
            });
          }
          const bytes = Buffer.from(data, "base64");
          if (offset + bytes.length > meta.sizeBytes) {
            throw new AttachmentError(
              "ATTACHMENT_TOO_LARGE",
              `'${meta.name}' is larger than announced.`,
              { attachmentId, sizeBytes: meta.sizeBytes },
            );
          }
          let received: number;
          try {
            received = await blobs.append(BLOB_NAMESPACE, meta.key, bytes, { offset });
          } catch (error) {
            if ((error as { code?: unknown }).code !== "CONFLICT") throw error;
            const size = (await blobs.stat(BLOB_NAMESPACE, meta.key))?.size ?? 0;
            throw new AttachmentError(
              "ATTACHMENT_OFFSET",
              `The upload has ${size} bytes, not ${offset}`,
              { attachmentId, received: size },
            );
          }
          return { received, complete: received === meta.sizeBytes };
        }),
    });

    commands.register({
      name: "attachments.read",
      description: "Reads part of an attachment (base64, at most 1 MiB), to show or download it",
      input: z.object({
        attachmentId: z.string(),
        offset: z.number().int().min(0).default(0),
        length: z.number().int().min(1).max(MAX_CHUNK_BYTES).default(MAX_CHUNK_BYTES),
      }),
      output: z.object({
        kind: z.enum(["image", "file"]),
        name: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number(),
        offset: z.number(),
        data: z.string(),
        done: z.boolean(),
      }),
      permissions: ["threads.read"],
      handler: async ({ attachmentId, offset, length }) => {
        const blobs = store();
        const meta = await getMeta(attachmentId);
        const bytes = await blobs.read(BLOB_NAMESPACE, meta.key, { offset, length });
        if (bytes === undefined) {
          throw new AttachmentError("ATTACHMENT_NOT_FOUND", "Attachment was not found.", {
            attachmentId,
          });
        }
        return {
          kind: meta.kind,
          name: meta.name,
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes,
          offset,
          data: Buffer.from(bytes).toString("base64"),
          done: offset + bytes.length >= meta.sizeBytes,
        };
      },
    });

    commands.register({
      name: "attachments.discard",
      description: "Removes an upload that was not sent (removed from the composer)",
      input: z.object({ attachmentId: z.string() }),
      output: z.object({ discarded: z.boolean() }),
      permissions: ["threads.write"],
      handler: ({ attachmentId }) =>
        queued(metaKey(attachmentId), async () => {
          const meta = await getMeta(attachmentId).catch(() => undefined);
          if (meta === undefined || meta.threadId !== undefined) return { discarded: false };
          await remove(meta);
          return { discarded: true };
        }),
    });
  }

  /**
   * Checks the limits of a message's attachments and claims the uploaded ones
   * for `threadId` (D293). Sending one again to the same thread (a retry) is
   * fine; to another thread it is not found. Returns them as the node knows them.
   */
  async function claim(
    threadId: string,
    attachments: readonly TurnAttachment[],
  ): Promise<TurnAttachment[]> {
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new AttachmentError(
        "ATTACHMENTS_TOO_MANY",
        `You can attach up to ${MAX_ATTACHMENTS} files per message.`,
      );
    }
    const stored = attachments.filter((item): item is StoredAttachment => "id" in item);
    if (stored.length === 0) return [...attachments];
    const blobs = store();
    const metas = await Promise.all(stored.map((item) => getMeta(item.id)));
    if (new Set(metas.map((meta) => meta.id)).size !== metas.length) {
      throw new AttachmentError("ATTACHMENT_DUPLICATE", "An attachment is named twice.");
    }
    const images = metas
      .filter((meta) => meta.kind === "image")
      .reduce((total, meta) => total + meta.sizeBytes, 0);
    if (images > MAX_TOTAL_IMAGE_BYTES) {
      throw new AttachmentError(
        "ATTACHMENTS_TOO_LARGE",
        "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.",
      );
    }
    const claimed = new Map<string, Meta>();
    for (const meta of metas) {
      const next = await queued(metaKey(meta.id), async () => {
        const latest = await getMeta(meta.id);
        if (latest.threadId === threadId) return latest;
        if (latest.threadId !== undefined) {
          throw new AttachmentError("ATTACHMENT_NOT_FOUND", "Attachment was not found.", {
            attachmentId: meta.id,
          });
        }
        const size = (await blobs.stat(BLOB_NAMESPACE, latest.key))?.size ?? 0;
        if (size !== latest.sizeBytes) {
          throw new AttachmentError(
            "ATTACHMENT_INCOMPLETE",
            `Attachment '${latest.name}' did not finish uploading.`,
            { attachmentId: meta.id, received: size, sizeBytes: latest.sizeBytes },
          );
        }
        const key = `thread/${threadId}/${latest.key.slice("pending/".length)}`;
        await blobs.move(BLOB_NAMESPACE, latest.key, key);
        const owned: Meta = { ...latest, key, threadId };
        await kv.set(namespace, metaKey(meta.id), owned as unknown as Json);
        return owned;
      });
      claimed.set(meta.id, next);
    }
    // The node's record wins over what the message said of each attachment.
    return attachments.map((item) => {
      if (!("id" in item)) return item;
      const meta = claimed.get(item.id)!;
      return {
        kind: meta.kind,
        id: meta.id,
        name: meta.name,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
      };
    });
  }

  /** The attachments as a runtime gets them: with their bytes and, where there is one, their file (D294). */
  async function resolve(
    attachments: readonly TurnAttachment[] | undefined,
  ): Promise<RuntimeAttachment[] | undefined> {
    if (attachments === undefined) return undefined;
    return Promise.all(
      attachments.map(async (item): Promise<RuntimeAttachment> => {
        if (!("id" in item)) return item;
        const meta = await getMeta(item.id);
        const blobs = store();
        const path = blobs.path?.(BLOB_NAMESPACE, meta.key);
        return {
          ...item,
          read: async () => (await blobs.read(BLOB_NAMESPACE, meta.key)) ?? new Uint8Array(),
          ...(path === undefined ? {} : { path }),
        };
      }),
    );
  }

  /** Deletes a deleted thread's attachments. */
  async function deleteThread(threadId: string): Promise<void> {
    if (deps.blobs === undefined) return;
    for (const entry of await kv.list(namespace, { prefix: "attachment/" })) {
      const parsed = Meta.safeParse(entry.value);
      if (!parsed.success || parsed.data.threadId !== threadId) continue;
      await queued(entry.key, () => remove(parsed.data));
    }
  }

  return { register, claim, resolve, deleteThread, sweep };
}
