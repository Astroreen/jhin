// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/lib/imageCompression.ts,
// packages/client-runtime/src/imageAttachmentSize.ts and packages/shared/src/imageDimensions.ts
// at eb7b35ac. The draft-stash compression is left out.

/**
 * Anthropic rejects an image over 2000px on a side once a request holds more than 20 images, and
 * Claude Code forwards images sent into a running turn unchanged, so one large paste breaks
 * every later request in that thread.
 */
export const IMAGE_ATTACHMENT_MAX_EDGE = 2000;
/**
 * Ceiling on the *source* file handed to the re-encoder. File size is a
 * proxy for pixel count, and decoding hundreds of megapixels into an
 * ImageBitmap can OOM the tab — beyond this we refuse rather than risk it.
 */
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_HEIC_DECODE_PIXELS = 64_000_000;
const MAX_HEIC_METADATA_BYTES = 1024 * 1024;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;
/**
 * Enough for every supported header. A JPEG's frame header can sit behind
 * several 64 KiB metadata segments (EXIF, an ICC profile, XMP), so allow a
 * few of them before giving up.
 */
const IMAGE_DIMENSIONS_HEADER_BYTES = 256 * 1024;

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export type ImageCompressionFailureReason = "too-large" | "unreadable";

export type CompressImageFileResult =
  | { ok: true; file: File; recompressed: boolean; imageSize?: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

// --- Image size math ------------------------------------------------------

export type DownscalableImageMimeType = "image/png" | "image/jpeg";

/** The codec to re-encode a downscaled image in, or null when the type is not downscaled. */
export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

/** The size that fits the max edge keeping the aspect ratio, or null when it already fits. */
export function fitImageAttachmentSize(size: ImageSize): ImageSize | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null;
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.height * scale))),
  };
}

/** The length of the base64 data URL a blob encodes to. */
export function dataUrlLength(blob: Pick<Blob, "size" | "type">): number {
  return (
    `data:${blob.type || "application/octet-stream"};base64,`.length + 4 * Math.ceil(blob.size / 3)
  );
}

/** The base64 character budget that keeps the decoded bytes within `maxBytes`. */
export function dataUrlBudgetForBytes(maxBytes: number): number {
  return Math.floor(maxBytes / 3) * 4;
}

// --- Image headers --------------------------------------------------------

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Width and height from a PNG, GIF, WebP or JPEG header (JPEG honours EXIF rotation). */
export function readImageDimensions(bytes: Uint8Array): ImageSize | null {
  const dimensions = readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes);
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

function readPng(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const data = view(bytes);
  return { width: data.getUint32(16), height: data.getUint32(20) };
}

function readGif(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38) return null;
  const data = view(bytes);
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) };
}

function readWebp(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 16) return null;
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return null;
  }
  const data = view(bytes);
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  switch (chunk) {
    case "VP8 ":
      if (bytes.length < 30) return null;
      return {
        width: data.getUint16(26, true) & 0x3fff,
        height: data.getUint16(28, true) & 0x3fff,
      };
    case "VP8L": {
      if (bytes.length < 25) return null;
      const packed = data.getUint32(21, true);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      if (bytes.length < 30) return null;
      return {
        width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1,
        height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1,
      };
    default:
      return null;
  }
}

function readJpeg(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const data = view(bytes);
  let offset = 2;
  let rotated = false;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start-of-frame markers carry the dimensions; skip the arithmetic-coding
    // and Huffman-table markers that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = data.getUint16(offset + 5);
      const width = data.getUint16(offset + 7);
      return rotated ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    // TEM and the restart markers stand alone, with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.getUint16(offset + 2);
    // Viewers apply the EXIF orientation before display, so a phone photo
    // stored on its side takes the swapped size on screen.
    if (marker === 0xe1 && !rotated) {
      rotated = exifOrientationSwapsAxes(bytes, offset + 4, offset + 2 + length);
    }
    offset += 2 + length;
  }
  return null;
}

function exifOrientationSwapsAxes(bytes: Uint8Array, start: number, end: number): boolean {
  end = Math.min(end, bytes.length);
  if (end - start < 14 || String.fromCharCode(...bytes.subarray(start, start + 4)) !== "Exif") {
    return false;
  }
  const tiff = start + 6;
  const data = view(bytes);
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!littleEndian && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return false;
  const ifd = tiff + data.getUint32(tiff + 4, littleEndian);
  if (ifd + 2 > end) return false;
  const entries = data.getUint16(ifd, littleEndian);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return false;
    if (data.getUint16(entry, littleEndian) === 0x0112) {
      const orientation = data.getUint16(entry + 8, littleEndian);
      return orientation >= 5 && orientation <= 8;
    }
  }
  return false;
}

// --- HEIC -----------------------------------------------------------------

/** Finder and some browsers omit the MIME type when dragging HEIC photos. */
export function isHeicImageFile(file: Pick<File, "name" | "type">): boolean {
  if (HEIC_IMAGE_MIME_TYPE.test(file.type)) {
    return true;
  }
  return (
    (file.type === "" || file.type.toLowerCase() === "application/octet-stream") &&
    HEIC_IMAGE_EXTENSION.test(file.name)
  );
}

interface HeicMetadataBox {
  payloadOffset: number;
  endOffset: number;
}

function findHeicMetadataBox(
  data: DataView,
  startOffset: number,
  endOffset: number,
  type: number,
): HeicMetadataBox | null {
  let offset = startOffset;
  while (offset + 8 <= endOffset) {
    let size = data.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > endOffset) return null;
      const extendedSize = data.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = endOffset - offset;
    }
    if (size < headerSize || size > endOffset - offset) return null;

    const nextOffset = offset + size;
    if (data.getUint32(offset + 4) === type) {
      return { payloadOffset: offset + headerSize, endOffset: nextOffset };
    }
    offset = nextOffset;
  }
  return null;
}

/**
 * Walks the ISOBMFF `meta/iprp/ipco/ispe` boxes of a HEIC header and refuses an image whose
 * pixel count would be too large to decode; null means every image size was found and fits.
 */
export function checkHeicImageDimensions(
  metadata: ArrayBuffer,
): ImageCompressionFailureReason | null {
  const data = new DataView(metadata);
  const meta = findHeicMetadataBox(data, 0, data.byteLength, 0x6d657461);
  if (!meta || meta.payloadOffset + 4 > meta.endOffset) return "unreadable";
  const properties = findHeicMetadataBox(data, meta.payloadOffset + 4, meta.endOffset, 0x69707270);
  if (!properties) return "unreadable";
  const containers = findHeicMetadataBox(
    data,
    properties.payloadOffset,
    properties.endOffset,
    0x6970636f,
  );
  if (!containers) return "unreadable";

  let offset = containers.payloadOffset;
  let foundImageDimensions = false;
  while (offset < containers.endOffset) {
    const image = findHeicMetadataBox(data, offset, containers.endOffset, 0x69737065);
    if (!image) break;
    if (image.payloadOffset + 12 > image.endOffset) return "unreadable";
    const width = data.getUint32(image.payloadOffset + 4);
    const height = data.getUint32(image.payloadOffset + 8);
    if (width === 0 || height === 0) return "unreadable";
    if (width > MAX_HEIC_DECODE_PIXELS / height) return "too-large";
    foundImageDimensions = true;
    offset = image.endOffset;
  }
  return foundImageDimensions ? null : "unreadable";
}

async function validateHeicImageDimensions(
  file: File,
): Promise<ImageCompressionFailureReason | null> {
  return checkHeicImageDimensions(await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer());
}

// --- Canvas encoding ------------------------------------------------------

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

/** The file name with its extension swapped for the re-encoded codec. */
export function fileNameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === "image/webp" ? ".webp" : ".jpg";
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return `${base}${extension}`;
}

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    return { canvas, context };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  return { canvas, context };
}

async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
): Promise<Blob | null> {
  let blob: Blob | null;
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  } else {
    blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  }
  return blob?.type === mimeType ? blob : null;
}

const composerThumbnails = new WeakMap<File, Promise<string | null>>();

/** A 256 px square PNG data URL cropped from the image's centre, cached per file. */
export function createComposerImageThumbnail(file: File): Promise<string | null> {
  const cached = composerThumbnails.get(file);
  if (cached) return cached;
  const thumbnail = (async () => {
    if (!canRecompress()) return null;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      if (side <= 0) return null;
      const dimension = Math.min(256, side);
      const surface = createCanvas(dimension, dimension);
      if (!surface) return null;
      surface.context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        dimension,
        dimension,
      );
      const blob = await encodeCanvas(surface.canvas, 1, "image/png");
      return blob ? await readFileAsDataUrl(blob) : null;
    } catch {
      return null;
    } finally {
      bitmap?.close();
    }
  })();
  composerThumbnails.set(file, thumbnail);
  return thumbnail;
}

async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  budgetChars: number,
  preferredMimeType?: "image/jpeg",
): Promise<{ blob: Blob; mimeType: string; imageSize: ImageSize } | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height);
  if (!target) return null;

  // Probe WebP once; JPEG (no alpha) needs a white matte, so the fill has to
  // happen before drawing and depends on which codec we end up using.
  const mimeType =
    preferredMimeType ??
    ((await encodeCanvas(target.canvas, QUALITY_STEPS[0], "image/webp"))
      ? "image/webp"
      : "image/jpeg");

  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(target.canvas, quality, mimeType);
    if (!encoded) break;
    if (dataUrlLength(encoded) <= budgetChars) {
      return { blob: encoded, mimeType, imageSize: { width, height } };
    }
  }
  return null;
}

type ReencodeResult =
  | { ok: true; blob: Blob; mimeType: string; imageSize: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

async function reencodeWithinBudget(
  file: File,
  budgetChars: number,
  preferredMimeType?: "image/jpeg",
): Promise<ReencodeResult> {
  if (!canRecompress()) {
    return { ok: false, reason: "too-large" };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    // Each pass shrinks relative to the *previous target*, capped by
    // IMAGE_ATTACHMENT_MAX_EDGE. Scaling a fixed ceiling instead would be a no-op for
    // images already smaller than that ceiling — the fallback passes would
    // all resolve to the source size and never actually reduce resolution.
    const baseDimension = Math.min(
      IMAGE_ATTACHMENT_MAX_EDGE,
      Math.max(bitmap.width, bitmap.height),
    );
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale));
      let encoded: Awaited<ReturnType<typeof encodeWithinBudget>>;
      try {
        encoded = await encodeWithinBudget(bitmap, targetDimension, budgetChars, preferredMimeType);
      } catch {
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded) {
        return {
          ok: true,
          blob: encoded.blob,
          mimeType: encoded.mimeType,
          imageSize: encoded.imageSize,
        };
      }
    }
    return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
  } finally {
    bitmap.close();
  }
}

async function fitImageToMaxEdge(file: File): Promise<{ file: File; imageSize: ImageSize } | null> {
  const mimeType = downscalableImageMimeType(file.type);
  if (!mimeType || !canRecompress() || file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) return null;
  let bitmap: ImageBitmap | undefined;
  try {
    const header = readImageDimensions(
      new Uint8Array(await file.slice(0, IMAGE_DIMENSIONS_HEADER_BYTES).arrayBuffer()),
    );
    if (!header || !fitImageAttachmentSize(header)) return null;
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const imageSize = fitImageAttachmentSize(bitmap);
    if (!imageSize) return null;
    const target = createCanvas(imageSize.width, imageSize.height);
    if (!target) return null;
    target.context.imageSmoothingQuality = "high";
    target.context.drawImage(bitmap, 0, 0, imageSize.width, imageSize.height);
    const blob = await encodeCanvas(target.canvas, QUALITY_STEPS[0], mimeType);
    if (!blob) return null;
    return {
      file: new File([blob], file.name, { type: mimeType, lastModified: file.lastModified }),
      imageSize,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/**
 * Fits a PNG or JPEG to the max edge, then re-encodes (WebP, else JPEG, at falling quality and
 * size) until it is within `maxBytes`. A file that already fits is returned unchanged.
 */
async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
  options?: { preferredMimeType?: "image/jpeg"; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  const fitted = await fitImageToMaxEdge(file);
  if (fitted && fitted.file.size <= maxBytes) {
    return { ok: true, file: fitted.file, recompressed: true, imageSize: fitted.imageSize };
  }
  if (!fitted && file.size <= maxBytes) {
    return { ok: true, file, recompressed: false };
  }
  if ((options?.sourceSizeBytes ?? file.size) > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const reencoded = await reencodeWithinBudget(
    fitted?.file ?? file,
    dataUrlBudgetForBytes(maxBytes),
    options?.preferredMimeType,
  );
  if (!reencoded.ok) {
    return reencoded;
  }
  return {
    ok: true,
    file: new File(
      [reencoded.blob],
      fileNameForMimeType(file.name || "image", reencoded.mimeType),
      { type: reencoded.mimeType },
    ),
    recompressed: true,
    imageSize: reencoded.imageSize,
  };
}

/**
 * Prepares an image the user attached: HEIC is converted to JPEG (through `heic-to`, loaded on
 * demand), then everything is fitted to the max edge and compressed within `maxBytes`.
 */
export async function prepareImageForAttachment(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  if (!isHeicImageFile(file)) {
    return compressImageToByteLimit(file, maxBytes);
  }

  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let converted: Blob;
  try {
    const dimensionError = await validateHeicImageDimensions(file);
    if (dimensionError) {
      return { ok: false, reason: dimensionError };
    }
    const { heicTo } = await import("heic-to/csp");
    converted = await heicTo({ blob: file, type: "image/jpeg", quality: QUALITY_STEPS[0] });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const jpeg = new File([converted], fileNameForMimeType(file.name || "image", "image/jpeg"), {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
  const result = await compressImageToByteLimit(jpeg, maxBytes, {
    preferredMimeType: "image/jpeg",
    sourceSizeBytes: file.size,
  });

  return result.ok ? { ...result, recompressed: true } : result;
}
