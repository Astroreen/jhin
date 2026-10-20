// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/composerAttachmentFiles.ts,
// packages/client-runtime/src/textPaste.ts, packages/client-runtime/src/state/attachments.ts and
// the pasted-text fold in apps/web/src/components/chat/ChatComposer.tsx at eb7b35ac.
// The server upload-capability checks are left out.
import { isHeicImageFile } from "./image-compression.ts";

/** How the composer takes a file: as an image, as a file, or refused as an image it cannot send. */
export type AttachmentFileKind = "image" | "file" | "unsupported-image";

/** Image types every agent accepts in a turn. */
const SUPPORTED_IMAGE_MIME_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;

const SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);

function isSupportedImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over a
 * `File` with an empty or generic MIME type.
 */
export function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, "name" | "type">): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

/** The same file with an image MIME type taken from its name when it came without one. */
export function normalizeImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

export function classifyAttachmentFile(file: Pick<File, "name" | "type">): AttachmentFileKind {
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  return isSupportedImageMimeType(file.type) ? "image" : "unsupported-image";
}

/**
 * Whether the composer takes over a paste: always for images, and for other files only when
 * the clipboard carries no plain text (a copied file from a file manager, not rich text).
 */
export function shouldHandleAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (
    input.files.some((file) => {
      const classification = classifyAttachmentFile(file);
      return classification === "image" || classification === "unsupported-image";
    })
  ) {
    return true;
  }

  if (input.plainText.length > 0) {
    return false;
  }

  return input.files.some((file) => classifyAttachmentFile(file) === "file");
}

// --- Pasted text ----------------------------------------------------------

export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;

const textEncoder = new TextEncoder();

export type PastedTextDisposition = "attachment" | "inline";

/** Cmd+Shift+V on macOS, Ctrl+Shift+V elsewhere: paste as text, never as an attachment. */
export function isPasteAsTextShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  macPlatform: boolean,
): boolean {
  return (
    event.key.toLowerCase() === "v" &&
    event.shiftKey &&
    !event.altKey &&
    (macPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

/**
 * The threshold is byte-based: character counts substantially understate the
 * context cost of some Unicode-heavy clipboard contents.
 */
export function pastedTextDisposition(input: {
  readonly text: string;
  readonly canAttach: boolean;
  readonly bypassAutoAttachment?: boolean;
  readonly wouldExceedInputLimit?: boolean;
}): PastedTextDisposition {
  if (input.bypassAutoAttachment || !input.canAttach || input.text.length === 0) {
    return "inline";
  }
  return input.wouldExceedInputLimit ||
    input.text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES ||
    textEncoder.encode(input.text).byteLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES
    ? "attachment"
    : "inline";
}

/** `pasted-text.txt`, then `pasted-text-2.txt`, … — the first name not already taken. */
export function nextPastedTextFileName(existingNames: ReadonlyArray<string>): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) {
    return "pasted-text.txt";
  }
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}

/** A long paste as a plain-text file named after the ones already attached. */
export function pastedTextFile(text: string, existingNames: ReadonlyArray<string>): File {
  return new File([text], nextPastedTextFileName(existingNames), {
    type: "text/plain;charset=utf-8",
  });
}

// --- Sizes ----------------------------------------------------------------

export function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;
}

export function fileAttachmentTooLargeMessage(name: string, maxUploadBytes: number): string {
  const maxUploadSize =
    maxUploadBytes >= 1024 * 1024 && maxUploadBytes % (1024 * 1024) === 0
      ? `${maxUploadBytes / (1024 * 1024)} MB`
      : maxUploadBytes >= 1024 && maxUploadBytes % 1024 === 0
        ? `${maxUploadBytes / 1024} KB`
        : `${maxUploadBytes} ${maxUploadBytes === 1 ? "byte" : "bytes"}`;
  return `'${name}' exceeds the ${maxUploadSize} attachment limit.`;
}
