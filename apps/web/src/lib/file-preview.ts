// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac:
// packages/shared/src/filePreview.ts (filePreviewKind, decodeFilePreviewText), packages/shared/src/video.ts
// (videoMimeType), packages/shared/src/image.ts (GENERIC_MIME_TYPES) and
// apps/web/src/lib/videoFirstFrame.ts.

/** How an attached file is previewed. */
export type FilePreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "html"
  | "markdown"
  | "text"
  | "unsupported";

/** At most this much of a text file is shown (T3's FILE_TEXT_PREVIEW_MAX_BYTES). */
export const FILE_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
]);

const VIDEO_MIME_TYPE_BY_EXTENSION = new Map([
  ["avi", "video/x-msvideo"],
  ["m4v", "video/mp4"],
  ["mkv", "video/x-matroska"],
  ["mov", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["ogv", "video/ogg"],
  ["webm", "video/webm"],
]);

/** A video's MIME type, from its own or, when that is missing or generic, from its name. */
export function videoMimeType(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("video/")) return mimeType;
  if (mimeType !== "" && !GENERIC_MIME_TYPES.has(mimeType)) return null;
  const dotIndex = attachment.name.lastIndexOf(".");
  return dotIndex < 0
    ? null
    : (VIDEO_MIME_TYPE_BY_EXTENSION.get(attachment.name.slice(dotIndex + 1).toLowerCase()) ?? null);
}

/** A file attachment that is a video, shown as one (T3's isVideoAttachment). */
export function isVideoAttachment(attachment: {
  readonly kind: string;
  readonly name: string;
  readonly mimeType: string;
}): boolean {
  return attachment.kind === "file" && videoMimeType(attachment) !== null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const AUDIO_MIME_TYPE_BY_EXTENSION = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".flac", "audio/flac"],
  [".aac", "audio/aac"],
  [".m4a", "audio/mp4"],
  [".opus", "audio/ogg"],
  [".aiff", "audio/aiff"],
]);

function mediaMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return (
    IMAGE_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    videoMimeType({ name: `media${extension}`, mimeType: "" })
  );
}

function audioMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return AUDIO_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ?? null;
}

/** How a file is previewed, by its MIME type, or by its name when the type says little. */
export function filePreviewKind(file: {
  readonly name: string;
  readonly mimeType?: string;
}): FilePreviewKind {
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const name = file.name.toLowerCase();
  const extension = name.slice(name.lastIndexOf("."));
  const generic = !mime || mime === "application/octet-stream" || mime === "text/plain";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (generic) {
    if (extension === ".pdf") return "pdf";
    if (/^\.html?$/.test(extension)) return "html";
    if (/^\.(md|markdown|mdown|mkd|mdx)$/.test(extension)) return "markdown";
    const media = mediaMimeTypeFromExtension(extension);
    if (media?.startsWith("image/")) return "image";
    if (media?.startsWith("video/")) return "video";
    if (audioMimeTypeFromExtension(extension) !== null) return "audio";
    if (
      /^\.(txt|log|json|jsonc|jsonl|ndjson|yaml|yml|toml|ini|conf|config|env|csv|tsv|xml|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|rb|go|rs|swift|kt|kts|java|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|gql|vue|svelte|r|lua|ex|exs|erl|hs|clj|dart|diff|patch|lock|properties|gradle)$/.test(
        extension,
      ) ||
      /^(dockerfile|makefile|gemfile|rakefile|license|readme|\.gitignore|\.gitattributes|\.editorconfig|\.env)(\.|$)/i.test(
        name.split(/[\\/]/).at(-1) ?? "",
      )
    )
      return "text";
  }
  if (
    mime.startsWith("text/") ||
    /^(application\/(json|.*\+json|xml|.*\+xml|javascript|x-javascript|yaml|x-yaml|toml|sql))$/.test(
      mime,
    )
  )
    return "text";
  return "unsupported";
}

/** The first MiB of a file as UTF-8 text, or why it cannot be shown as text. */
export function decodeFilePreviewText(bytes: Uint8Array, truncated = false) {
  const bounded = bytes.subarray(0, FILE_TEXT_PREVIEW_MAX_BYTES);
  if (bounded.some((byte) => byte === 0))
    throw new Error("This file contains binary data and cannot be shown as text.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return {
      text: decoder.decode(bounded, { stream: truncated || bytes.length > bounded.length }),
      truncated: truncated || bytes.length > bounded.length,
    };
  } catch {
    throw new Error("This file is not UTF-8 text. Open it in another app to view its contents.");
  }
}

/**
 * Shows a video's first frame instead of black: a paused video that has not
 * played seeks a little way in, unless its URL names a start time.
 */
export function prepareVideoFirstFrame(
  video: Pick<
    HTMLVideoElement,
    "autoplay" | "currentTime" | "duration" | "paused" | "played" | "seeking" | "src"
  >,
): void {
  if (
    video.autoplay ||
    !video.paused ||
    video.seeking ||
    video.currentTime !== 0 ||
    video.played.length > 0 ||
    !Number.isFinite(video.duration) ||
    video.duration <= 0
  ) {
    return;
  }

  const fragment = video.src.split("#", 2)[1];
  if (fragment && new URLSearchParams(fragment).has("t")) return;

  try {
    video.currentTime = Math.min(0.1, video.duration / 2);
  } catch {
    // A rejected preview seek must leave the native Play control usable.
  }
}
