// Reading a file of the node for its preview (t3-parity.md D1003, D1342): a project's file
// through `projects.read-file`, a skill's SKILL.md through `agents.skill.read`.
import type { NodeTarget, ThreadsCatalog } from "@jhin/client-api";

import { FILE_TEXT_PREVIEW_MAX_BYTES, filePreviewKind } from "../../lib/file-preview.ts";

/** What `projects.read-file` and `agents.skill.read` answer. */
interface FileHead {
  readonly path: string;
  readonly sizeBytes: number;
  readonly data: string;
  readonly truncated: boolean;
}

/** Media is shown whole, up to a video's 50 MB (D855); text only its first MiB, as D854. */
const MEDIA_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

export interface PreviewFile {
  readonly sizeBytes: number;
  readonly file: Blob;
}

/** The node refused a medium past its limit before reading it. */
export const isTooLarge = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "FILE_TOO_LARGE";

/** Reads `name` with `method`: media whole or not at all, text its first MiB. */
export async function readPreviewFile(
  threads: Pick<ThreadsCatalog, "call">,
  target: NodeTarget,
  name: string,
  method: "projects.read-file" | "agents.skill.read",
  input: Record<string, unknown>,
): Promise<PreviewFile> {
  const media = ["image", "video", "audio", "pdf"].includes(filePreviewKind({ name }));
  // Media is refused on the node before it is read; one byte past the text's limit tells the
  // preview the text was cut.
  const limit = media
    ? { maxBytes: MEDIA_PREVIEW_MAX_BYTES, whole: true }
    : { maxBytes: FILE_TEXT_PREVIEW_MAX_BYTES + 1 };
  const head = await threads.call<FileHead>(target, method, { ...input, ...limit });
  return { sizeBytes: head.sizeBytes, file: new Blob([decodeBase64(head.data)]) };
}

/** Base64 to bytes: the browser's own decoder where it has one, else in one pass. */
function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> })
    .fromBase64;
  if (native !== undefined) return native(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
