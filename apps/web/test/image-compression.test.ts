import { describe, expect, it } from "vite-plus/test";

import {
  checkHeicImageDimensions,
  dataUrlBudgetForBytes,
  dataUrlLength,
  downscalableImageMimeType,
  fileNameForMimeType,
  fitImageAttachmentSize,
  IMAGE_ATTACHMENT_MAX_EDGE,
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  prepareImageForAttachment,
  readImageDimensions,
} from "../src/lib/image-compression.ts";

const encoder = new TextEncoder();

function box(type: string, ...contents: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(8 + contents.reduce((size, content) => size + content.length, 0));
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(encoder.encode(type), 4);
  let offset = 8;
  for (const content of contents) {
    bytes.set(content, offset);
    offset += content.length;
  }
  return bytes;
}

/** A HEIC header: ftyp, then meta (full box: 4 version/flags bytes) > iprp > ipco > ispe. */
function heicHeader(...sizes: Array<[number, number]>): Uint8Array {
  const ispes = sizes.map(([width, height]) => {
    const payload = new Uint8Array(12);
    const data = new DataView(payload.buffer);
    data.setUint32(4, width);
    data.setUint32(8, height);
    return box("ispe", payload);
  });
  return concat(
    box("ftyp", encoder.encode("heic")),
    box("meta", new Uint8Array(4), box("iprp", box("ipco", ...ispes))),
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

const buffer = (bytes: Uint8Array) => bytes.slice().buffer;

describe("isHeicImageFile", () => {
  it("detects HEIC by type, or by name when the type is missing", () => {
    expect(isHeicImageFile({ name: "a.jpg", type: "image/heic" })).toBe(true);
    expect(isHeicImageFile({ name: "a", type: "IMAGE/HEIF" })).toBe(true);
    expect(isHeicImageFile({ name: "IMG_1.HEIC", type: "" })).toBe(true);
    expect(isHeicImageFile({ name: "a.heif", type: "application/octet-stream" })).toBe(true);
    expect(isHeicImageFile({ name: "a.heic", type: "image/png" })).toBe(false);
    expect(isHeicImageFile({ name: "a.png", type: "" })).toBe(false);
  });
});

describe("checkHeicImageDimensions", () => {
  it("accepts an image within the decode limit", () => {
    expect(checkHeicImageDimensions(buffer(heicHeader([4000, 3000])))).toBeNull();
    expect(checkHeicImageDimensions(buffer(heicHeader([8000, 8000])))).toBeNull();
  });

  it("refuses one over 64 megapixels, in any of its items", () => {
    expect(checkHeicImageDimensions(buffer(heicHeader([8001, 8000])))).toBe("too-large");
    expect(checkHeicImageDimensions(buffer(heicHeader([100, 100], [10000, 7000])))).toBe(
      "too-large",
    );
  });

  it("calls a malformed header unreadable", () => {
    expect(checkHeicImageDimensions(buffer(heicHeader()))).toBe("unreadable");
    expect(checkHeicImageDimensions(buffer(heicHeader([0, 100])))).toBe("unreadable");
    expect(checkHeicImageDimensions(buffer(box("ftyp", encoder.encode("heic"))))).toBe(
      "unreadable",
    );
    const truncated = heicHeader([4000, 3000]);
    expect(checkHeicImageDimensions(buffer(truncated.subarray(0, truncated.length - 4)))).toBe(
      "unreadable",
    );
  });
});

describe("readImageDimensions", () => {
  it("reads a PNG header", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set(encoder.encode("IHDR"), 12);
    new DataView(png.buffer).setUint32(16, 3000);
    new DataView(png.buffer).setUint32(20, 1500);
    expect(readImageDimensions(png)).toEqual({ width: 3000, height: 1500 });
  });

  it("reads a GIF header", () => {
    const gif = new Uint8Array(10);
    gif.set(encoder.encode("GIF89a"));
    new DataView(gif.buffer).setUint16(6, 320, true);
    new DataView(gif.buffer).setUint16(8, 200, true);
    expect(readImageDimensions(gif)).toEqual({ width: 320, height: 200 });
  });

  it("reads a JPEG frame header", () => {
    // SOI, an APP0 segment, then SOF0 with height 480 and width 640.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x03,
    ]);
    expect(readImageDimensions(jpeg)).toEqual({ width: 640, height: 480 });
  });

  it("returns null for anything else", () => {
    expect(readImageDimensions(new Uint8Array(32))).toBeNull();
  });
});

describe("size and budget math", () => {
  it("fits the longest edge to 2000 px", () => {
    expect(IMAGE_ATTACHMENT_MAX_EDGE).toBe(2000);
    expect(fitImageAttachmentSize({ width: 2000, height: 1000 })).toBeNull();
    expect(fitImageAttachmentSize({ width: 4000, height: 3000 })).toEqual({
      width: 2000,
      height: 1500,
    });
    expect(fitImageAttachmentSize({ width: 100, height: 100_000 })).toEqual({
      width: 2,
      height: 2000,
    });
  });

  it("downscales only PNG and JPEG", () => {
    expect(downscalableImageMimeType("image/PNG")).toBe("image/png");
    expect(downscalableImageMimeType("image/jpg")).toBe("image/jpeg");
    expect(downscalableImageMimeType("image/webp")).toBeNull();
  });

  it("measures data URLs and budgets bytes as base64", () => {
    expect(dataUrlLength({ size: 3, type: "image/png" })).toBe("data:image/png;base64,".length + 4);
    expect(dataUrlLength({ size: 4, type: "" })).toBe(
      "data:application/octet-stream;base64,".length + 8,
    );
    expect(dataUrlBudgetForBytes(3 * 1024 * 1024)).toBe(4 * 1024 * 1024);
    expect(dataUrlBudgetForBytes(10)).toBe(12);
  });

  it("renames a re-encoded file for its codec", () => {
    expect(fileNameForMimeType("shot.png", "image/webp")).toBe("shot.webp");
    expect(fileNameForMimeType("IMG_1.HEIC", "image/jpeg")).toBe("IMG_1.jpg");
    expect(fileNameForMimeType(".hidden", "image/jpeg")).toBe(".hidden.jpg");
  });
});

describe("prepareImageForAttachment without a canvas", () => {
  it("passes a file within the limit through", async () => {
    const file = new File([new Uint8Array(100)], "a.png", { type: "image/png" });
    expect(await prepareImageForAttachment(file, 1000)).toEqual({
      ok: true,
      file,
      recompressed: false,
    });
  });

  it("refuses a file over the limit it cannot re-encode", async () => {
    const file = new File([new Uint8Array(2000)], "a.png", { type: "image/png" });
    expect(await prepareImageForAttachment(file, 1000)).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses HEIC over the source limit, or too big to decode, before converting", async () => {
    const oversized = new File([new Uint8Array(MAX_COMPRESSIBLE_SOURCE_BYTES + 1)], "a.heic", {
      type: "image/heic",
    });
    expect(await prepareImageForAttachment(oversized, 1000)).toEqual({
      ok: false,
      reason: "too-large",
    });
    const giant = new File([buffer(heicHeader([10000, 10000]))], "a.heic", { type: "" });
    expect(await prepareImageForAttachment(giant, 1000)).toEqual({
      ok: false,
      reason: "too-large",
    });
    const broken = new File([new Uint8Array(64)], "a.heic", { type: "image/heic" });
    expect(await prepareImageForAttachment(broken, 1000)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});
