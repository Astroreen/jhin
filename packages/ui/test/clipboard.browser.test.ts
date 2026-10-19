import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { copyText } from "../src/clipboard.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("falls back to the copy command when the Clipboard API refuses", async () => {
    expect(window.isSecureContext).toBe(true);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Document is not focused.", "NotAllowedError"),
    );
    const copy = vi.spyOn(document, "execCommand").mockReturnValue(true);
    await copyText("hello");
    expect(copy).toHaveBeenCalledWith("copy");
  });

  it("rejects when neither way copied", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("refused"));
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    await expect(copyText("hello")).rejects.toThrow("The browser did not copy the text");
  });
});
