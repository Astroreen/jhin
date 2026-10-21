import { describe, expect, it } from "vite-plus/test";

import {
  FILE_TEXT_PREVIEW_MAX_BYTES,
  decodeFilePreviewText,
  filePreviewKind,
  isVideoAttachment,
  prepareVideoFirstFrame,
  videoMimeType,
} from "../src/lib/file-preview.ts";

describe("file previews (T3's filePreview.ts)", () => {
  it("previews a file by its type, or by its name when the type says little", () => {
    expect(filePreviewKind({ name: "a.pdf", mimeType: "application/pdf" })).toBe("pdf");
    expect(filePreviewKind({ name: "a", mimeType: "text/html" })).toBe("html");
    expect(filePreviewKind({ name: "notes.md", mimeType: "text/markdown" })).toBe("markdown");
    expect(filePreviewKind({ name: "notes.md", mimeType: "text/plain" })).toBe("markdown");
    expect(filePreviewKind({ name: "clip.mov", mimeType: "" })).toBe("video");
    expect(filePreviewKind({ name: "song.mp3", mimeType: "application/octet-stream" })).toBe(
      "audio",
    );
    expect(filePreviewKind({ name: "app.ts", mimeType: "" })).toBe("text");
    expect(filePreviewKind({ name: "Dockerfile" })).toBe("text");
    expect(filePreviewKind({ name: "data", mimeType: "application/json" })).toBe("text");
    expect(filePreviewKind({ name: "a.zip", mimeType: "application/zip" })).toBe("unsupported");
  });

  it("knows T3's video types, from the type or the name", () => {
    expect(videoMimeType({ name: "x", mimeType: "video/webm; codecs=vp9" })).toBe("video/webm");
    expect(videoMimeType({ name: "clip.MOV", mimeType: "" })).toBe("video/quicktime");
    expect(videoMimeType({ name: "clip.mkv", mimeType: "application/octet-stream" })).toBe(
      "video/x-matroska",
    );
    // A specific type that is not a video wins over the name.
    expect(videoMimeType({ name: "clip.mp4", mimeType: "text/plain" })).toBeNull();
    expect(isVideoAttachment({ kind: "file", name: "a.mp4", mimeType: "video/mp4" })).toBe(true);
    expect(isVideoAttachment({ kind: "image", name: "a.mp4", mimeType: "video/mp4" })).toBe(false);
  });

  it("decodes the first MiB as UTF-8, and refuses binary data", () => {
    const encoder = new TextEncoder();
    expect(decodeFilePreviewText(encoder.encode("héllo"))).toEqual({
      text: "héllo",
      truncated: false,
    });
    const long = new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES + 1).fill(97);
    const decoded = decodeFilePreviewText(long);
    expect(decoded.truncated).toBe(true);
    expect(decoded.text).toHaveLength(FILE_TEXT_PREVIEW_MAX_BYTES);
    expect(decodeFilePreviewText(encoder.encode("hi"), true).truncated).toBe(true);
    expect(() => decodeFilePreviewText(new Uint8Array([104, 0]))).toThrow(
      "This file contains binary data and cannot be shown as text.",
    );
    expect(() => decodeFilePreviewText(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow(
      "This file is not UTF-8 text. Open it in another app to view its contents.",
    );
  });

  it("seeks a fresh paused video to its first frame, and leaves others alone", () => {
    const video = (change: Partial<HTMLVideoElement> = {}) => ({
      autoplay: false,
      currentTime: 0,
      duration: 4,
      paused: true,
      played: { length: 0 } as TimeRanges,
      seeking: false,
      src: "blob:x",
      ...change,
    });
    const fresh = video();
    prepareVideoFirstFrame(fresh);
    expect(fresh.currentTime).toBe(0.1);
    const short = video({ duration: 0.1 });
    prepareVideoFirstFrame(short);
    expect(short.currentTime).toBe(0.05);
    for (const other of [
      video({ autoplay: true }),
      video({ paused: false }),
      video({ duration: Number.NaN }),
      video({ src: "blob:x#t=3" }),
    ]) {
      prepareVideoFirstFrame(other);
      expect(other.currentTime).toBe(0);
    }
  });
});
