import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_UPLOAD_MAX_BYTES,
  PREVIEW_UPLOAD_MAX_FILES,
  PreviewTabUploadInput,
} from "../src/index.ts";

const upload = (files: { name: string; data: string }[]) =>
  PreviewTabUploadInput.safeParse({ threadId: "t", tabId: "tab", viewer: "v", files });

describe("preview.tab.upload's input (D1203)", () => {
  it("takes T3's 20 files at most", () => {
    const file = { name: "a.txt", data: "aGk=" };
    expect(upload(Array.from({ length: PREVIEW_UPLOAD_MAX_FILES }, () => file)).success).toBe(true);
    expect(upload(Array.from({ length: PREVIEW_UPLOAD_MAX_FILES + 1 }, () => file)).success).toBe(
      false,
    );
  });

  it("takes 64 MiB of decoded bytes at most, across the files", () => {
    // Three bytes per four base64 characters.
    const atLimit = "A".repeat(Math.floor(PREVIEW_UPLOAD_MAX_BYTES / 3) * 4);
    const half = "A".repeat(Math.ceil(PREVIEW_UPLOAD_MAX_BYTES / 6) * 4);
    expect(upload([{ name: "a", data: atLimit }]).success).toBe(true);
    const over = upload([
      { name: "a", data: half },
      { name: "b", data: half },
    ]);
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe("An upload carries at most 64 MiB.");
  });

  it("refuses file data that is not base64", () => {
    expect(upload([{ name: "a", data: "not base64!" }]).success).toBe(false);
    expect(upload([{ name: "a", data: "abc" }]).success).toBe(false);
    expect(upload([{ name: "a", data: "" }]).success).toBe(true);
  });
});
