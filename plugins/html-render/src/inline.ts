// Inlining local images follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/htmlRender/HtmlRender.ts (the absolute-path pattern, the size limits, sniffing
// image bytes so a renamed file cannot carry other data into a page, and the error wording).
import * as Fs from "node:fs/promises";

import { HtmlRenderError } from "@jhin/preview-api";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 25 * 1024 * 1024;
const MIB = 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

function findLocalImages(html: string) {
  return Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span === undefined
      ? []
      : [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }];
  });
}

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const mimeOf = (path: string) =>
  IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ??
  "application/octet-stream";

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Whether the bytes are an image, whatever the file is named. */
export function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  // An SVG root after any XML declaration, comments or doctype.
  const text = new TextDecoder().decode(bytes.subarray(0, 4096));
  const stripped = text.replace(/^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)*/i, "");
  return /^<svg[ \t\r\n/>]/.test(stripped);
}

const mib = (bytes: number) => (bytes / MIB).toFixed(1);

/**
 * Inlines the page's local images as data URIs. A path that is not a readable
 * image file counts as missing; too large an image or page fails.
 */
export async function inlineLocalImages(
  html: string,
): Promise<{ html: string; missing: string[] }> {
  const found = findLocalImages(html);
  if (found.length === 0) return { html, missing: [] };
  const paths = [...new Set(found.map((image) => image.path))];
  const sizes = new Map<string, number>();
  await Promise.all(
    paths.map(async (path) => {
      const stat = await Fs.stat(filePathFor(path)).catch(() => undefined);
      if (stat?.isFile() === true) sizes.set(path, stat.size);
    }),
  );
  for (const [path, size] of sizes) {
    if (size > MAX_IMAGE_BYTES) {
      throw new HtmlRenderError(
        "HTML_RENDER_INVALID_PAGE",
        `${path} is ${mib(size)} MiB; each local image must be at most ${mib(MAX_IMAGE_BYTES)} MiB.`,
      );
    }
  }
  // Every occurrence is inlined: an image used five times counts five times.
  const projected =
    Buffer.byteLength(html) +
    found.reduce((total, image) => total + ((sizes.get(image.path) ?? 0) * 4) / 3, 0);
  if (projected > MAX_PAGE_BYTES) {
    throw new HtmlRenderError(
      "HTML_RENDER_INVALID_PAGE",
      `With its images inlined the page is ${mib(projected)} MiB; the limit is ${mib(MAX_PAGE_BYTES)} MiB. Use smaller images.`,
    );
  }
  const data = new Map<string, string>();
  await Promise.all(
    [...sizes.keys()].map(async (path) => {
      const bytes = await Fs.readFile(filePathFor(path)).catch(() => undefined);
      if (bytes === undefined || bytes.byteLength > MAX_IMAGE_BYTES || !isImageBytes(bytes)) return;
      data.set(path, `data:${mimeOf(path)};base64,${bytes.toString("base64")}`);
    }),
  );
  let result = "";
  let at = 0;
  for (const image of found) {
    const uri = data.get(image.path);
    if (uri === undefined) continue;
    result += html.slice(at, image.start) + uri;
    at = image.end;
  }
  result += html.slice(at);
  if (Buffer.byteLength(result) > MAX_PAGE_BYTES) {
    throw new HtmlRenderError(
      "HTML_RENDER_INVALID_PAGE",
      `With its images inlined the page is ${mib(Buffer.byteLength(result))} MiB; the limit is ${mib(MAX_PAGE_BYTES)} MiB. Use smaller images.`,
    );
  }
  return { html: result, missing: paths.filter((path) => !data.has(path)) };
}

export function missingImagesError(missing: readonly string[]): HtmlRenderError {
  return new HtmlRenderError(
    "HTML_RENDER_INVALID_PAGE",
    `These local images could not be read: ${missing.join(", ")}. Use absolute paths to existing image files, or remove them.`,
    { missing },
  );
}
