import { describe, expect, it } from "vite-plus/test";

import {
  armPasteAsText,
  classifyAttachmentFile,
  consumeArmedPasteAsText,
  fileAttachmentTooLargeMessage,
  formatAttachmentSize,
  inferImageMimeTypeFromName,
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  normalizeImageFileMimeType,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  pastedTextDisposition,
  pastedTextFile,
  shouldHandleAttachmentPaste,
} from "../src/lib/attachment-files.ts";

const file = (name: string, type: string) => new File(["x"], name, { type });

describe("classifyAttachmentFile", () => {
  it("takes supported images as images", () => {
    expect(classifyAttachmentFile(file("a.png", "image/png"))).toBe("image");
    expect(classifyAttachmentFile(file("a.webp", "IMAGE/WEBP"))).toBe("image");
  });

  it("takes HEIC and nameless-typed images as images", () => {
    expect(classifyAttachmentFile(file("a.heic", "image/heic"))).toBe("image");
    expect(classifyAttachmentFile(file("a.HEIF", ""))).toBe("image");
    expect(classifyAttachmentFile(file("a.jpg", "application/octet-stream"))).toBe("image");
  });

  it("refuses images no agent accepts", () => {
    expect(classifyAttachmentFile(file("a.svg", "image/svg+xml"))).toBe("unsupported-image");
    expect(classifyAttachmentFile(file("a.tiff", "image/tiff"))).toBe("unsupported-image");
  });

  it("takes everything else as a file", () => {
    expect(classifyAttachmentFile(file("a.pdf", "application/pdf"))).toBe("file");
    expect(classifyAttachmentFile(file("notes", ""))).toBe("file");
    // A typed file keeps its type even with an image-looking name.
    expect(classifyAttachmentFile(file("a.png", "text/plain"))).toBe("file");
  });
});

describe("MIME normalization", () => {
  it("infers an image type from the extension", () => {
    expect(inferImageMimeTypeFromName("shot.JPG")).toBe("image/jpeg");
    expect(inferImageMimeTypeFromName("shot.jpeg")).toBe("image/jpeg");
    expect(inferImageMimeTypeFromName("a.gif")).toBe("image/gif");
    expect(inferImageMimeTypeFromName(".png")).toBeNull();
    expect(inferImageMimeTypeFromName("readme")).toBeNull();
    expect(inferImageMimeTypeFromName("a.txt")).toBeNull();
  });

  it("retypes an untyped image file and leaves typed ones alone", () => {
    const untyped = new File(["x"], "shot.png", { type: "", lastModified: 42 });
    const normalized = normalizeImageFileMimeType(untyped);
    expect(normalized.type).toBe("image/png");
    expect(normalized.name).toBe("shot.png");
    expect(normalized.lastModified).toBe(42);

    const typed = file("shot.png", "image/png");
    expect(normalizeImageFileMimeType(typed)).toBe(typed);
    const other = file("data.bin", "");
    expect(normalizeImageFileMimeType(other)).toBe(other);
  });
});

describe("shouldHandleAttachmentPaste", () => {
  it("handles any image, even alongside text", () => {
    expect(
      shouldHandleAttachmentPaste({ files: [file("a.png", "image/png")], plainText: "hi" }),
    ).toBe(true);
    expect(
      shouldHandleAttachmentPaste({ files: [file("a.svg", "image/svg+xml")], plainText: "hi" }),
    ).toBe(true);
  });

  it("handles plain files only when there is no text", () => {
    const pdf = file("a.pdf", "application/pdf");
    expect(shouldHandleAttachmentPaste({ files: [pdf], plainText: "" })).toBe(true);
    expect(shouldHandleAttachmentPaste({ files: [pdf], plainText: "a.pdf" })).toBe(false);
    expect(shouldHandleAttachmentPaste({ files: [], plainText: "" })).toBe(false);
  });
});

describe("pasted text", () => {
  it("names pasted files in sequence, case-insensitively", () => {
    expect(nextPastedTextFileName([])).toBe("pasted-text.txt");
    expect(nextPastedTextFileName(["Pasted-Text.txt"])).toBe("pasted-text-2.txt");
    expect(nextPastedTextFileName(["pasted-text.txt", "pasted-text-2.txt"])).toBe(
      "pasted-text-3.txt",
    );
    expect(nextPastedTextFileName(["pasted-text.txt", "pasted-text-3.txt"])).toBe(
      "pasted-text-2.txt",
    );
  });

  it("attaches text from 32 KiB on, counted in bytes", () => {
    expect(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES).toBe(32 * 1024);
    const below = "a".repeat(32 * 1024 - 1);
    expect(pastedTextDisposition({ text: below, canAttach: true })).toBe("inline");
    expect(pastedTextDisposition({ text: `${below}a`, canAttach: true })).toBe("attachment");
    // 11k three-byte characters are 33k bytes.
    expect(pastedTextDisposition({ text: "€".repeat(11 * 1024), canAttach: true })).toBe(
      "attachment",
    );
  });

  it("keeps text inline when attaching is off or bypassed", () => {
    const big = "a".repeat(64 * 1024);
    expect(pastedTextDisposition({ text: big, canAttach: false })).toBe("inline");
    expect(pastedTextDisposition({ text: big, canAttach: true, bypassAutoAttachment: true })).toBe(
      "inline",
    );
    expect(pastedTextDisposition({ text: "", canAttach: true })).toBe("inline");
    expect(
      pastedTextDisposition({ text: "short", canAttach: true, wouldExceedInputLimit: true }),
    ).toBe("attachment");
  });

  it("builds the pasted-text file", async () => {
    const pasted = pastedTextFile("hello", ["pasted-text.txt"]);
    expect(pasted.name).toBe("pasted-text-2.txt");
    expect(pasted.type).toBe("text/plain;charset=utf-8");
    expect(await pasted.text()).toBe("hello");
  });

  it("recognizes the paste-as-text shortcut per platform", () => {
    const keys = { key: "V", shiftKey: true, altKey: false };
    expect(isPasteAsTextShortcut({ ...keys, metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isPasteAsTextShortcut({ ...keys, metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isPasteAsTextShortcut({ ...keys, metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(
      isPasteAsTextShortcut({ ...keys, shiftKey: false, metaKey: false, ctrlKey: true }, false),
    ).toBe(false);
  });
});

describe("sizes", () => {
  it("formats attachment sizes", () => {
    expect(formatAttachmentSize(0)).toBe("1 KB");
    expect(formatAttachmentSize(1025)).toBe("2 KB");
    expect(formatAttachmentSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatAttachmentSize(5.25 * 1024 * 1024)).toBe("5.3 MB");
  });

  it("names the limit a file exceeds", () => {
    expect(fileAttachmentTooLargeMessage("a.zip", 10 * 1024 * 1024)).toBe(
      "'a.zip' exceeds the 10 MB attachment limit.",
    );
    expect(fileAttachmentTooLargeMessage("a.zip", 512 * 1024)).toBe(
      "'a.zip' exceeds the 512 KB attachment limit.",
    );
    expect(fileAttachmentTooLargeMessage("a.zip", 1)).toBe(
      "'a.zip' exceeds the 1 byte attachment limit.",
    );
    expect(fileAttachmentTooLargeMessage("a.zip", 1500)).toBe(
      "'a.zip' exceeds the 1500 bytes attachment limit.",
    );
  });
});

describe("Paste as Text from the desktop menu (D946)", () => {
  it("keeps the next paste inline within a second, once", () => {
    armPasteAsText(1_000);
    expect(consumeArmedPasteAsText(1_500)).toBe(true);
    expect(consumeArmedPasteAsText(1_600)).toBe(false);
  });

  it("expires after a second", () => {
    armPasteAsText(1_000);
    expect(consumeArmedPasteAsText(2_001)).toBe(false);
  });
});
