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

describe("copyText through the copy command", () => {
  it("copies from inside an open dialog and gives focus back", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("refused"));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    button.focus();
    let copiedFrom: Element | null = null;
    vi.spyOn(document, "execCommand").mockImplementation(() => {
      copiedFrom = document.activeElement?.closest('[role="dialog"]') ?? null;
      return true;
    });

    await copyText("hello");
    expect(copiedFrom).toBe(dialog);
    expect(document.activeElement).toBe(button);
    dialog.remove();
  });
});
