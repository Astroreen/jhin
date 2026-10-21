import type { StoredAttachment } from "@jhin/agent-api";
import { toDisposable, type PluginContext } from "@jhin/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { DiffSettings } from "../src/lib/settings.ts";
import type { AttachmentLoader } from "../src/plugins/chat/attachment-media.tsx";
import { AttachmentFilePreview } from "../src/plugins/chat/attachment-preview.tsx";
import { ChatContext, type ChatServices } from "../src/plugins/chat/services.ts";

/** The chat services the preview reads: the diff section's word wrap, and its patches. */
function services() {
  let current: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  const context = {
    config: {
      get: () => DiffSettings.parse(current),
      onDidChange: (_section: string, listener: () => void) => {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    },
  } as unknown as PluginContext;
  const settings = {
    values: () => current,
    patch: (_section: string, patch: Readonly<Record<string, unknown>>) => {
      current = { ...current, ...patch };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    reset: () => undefined,
  };
  return { context, settings } as unknown as ChatServices;
}

/** A node's attachment: `head` answers with `text`, `url` with an object URL of it. */
function nodeLoader(text: string, done = true) {
  const reads: string[] = [];
  const loader: AttachmentLoader = {
    url: async (attachment) => {
      reads.push(`url ${attachment.id}`);
      return URL.createObjectURL(new Blob([text], { type: attachment.mimeType }));
    },
    head: async (attachment, length) => {
      reads.push(`head ${attachment.id} ${length}`);
      return { bytes: new TextEncoder().encode(text), done };
    },
  };
  return { loader, reads };
}

const stored = (name: string, mimeType: string, sizeBytes: number): StoredAttachment => ({
  kind: "file",
  id: "att-1",
  name,
  mimeType,
  sizeBytes,
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  container.style.height = "600px";
  container.style.display = "flex";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ChatContext.Provider value={services()}>{element}</ChatContext.Provider>),
  );
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

describe("the preview of an attachment (T3's AttachmentFilePreview)", () => {
  it("renders a picked markdown file, and shows its source on request", async () => {
    const file = new File(["# Notes\n\nHello, world"], "notes.md", { type: "text/markdown" });
    await mount(
      <AttachmentFilePreview
        file={file}
        mimeType={file.type}
        name={file.name}
        onRemove={() => undefined}
        origin="Draft"
        sizeBytes={file.size}
      />,
    );
    await expect.element(page.getByRole("heading", { name: "Notes" })).toBeVisible();
    await expect.element(page.getByText("Draft")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy contents" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save file" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove from draft" })).toBeVisible();
    await page.getByRole("button", { name: "Show markdown source" }).click();
    await expect
      .element(page.getByRole("button", { name: "Show rendered markdown" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(page.getByRole("button", { name: "Disable word wrap" })).toBeVisible();
  });

  it("reads only the first MiB of a sent text file from its node, and says so", async () => {
    const { loader, reads } = nodeLoader("line one\nline two", false);
    await mount(
      <AttachmentFilePreview
        loader={loader}
        mimeType="text/plain"
        name="big.log"
        sizeBytes={2_000_000}
        stored={stored("big.log", "text/plain", 2_000_000)}
      />,
    );
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(
        "Preview limited to the first 1 MB of a 2,000,000 byte file. Save the file to read it in full.",
      );
    await expect.element(page.getByRole("button", { name: "Copy preview" })).toBeVisible();
    // Text needs no whole download.
    expect(reads).toEqual(["head att-1 1048576"]);
  });

  it("refuses binary data as text", async () => {
    const file = new File([new Uint8Array([104, 0, 105])], "data.txt", { type: "text/plain" });
    await mount(
      <AttachmentFilePreview file={file} mimeType={file.type} name={file.name} sizeBytes={3} />,
    );
    await expect
      .element(page.getByText("This file contains binary data and cannot be shown as text."))
      .toBeVisible();
  });

  it("says when a file has no preview", async () => {
    const file = new File(["PK"], "archive.zip", { type: "application/zip" });
    await mount(
      <AttachmentFilePreview file={file} mimeType={file.type} name={file.name} sizeBytes={2} />,
    );
    await expect.element(page.getByText("No preview for this file")).toBeVisible();
    await expect
      .element(page.getByText("Save it to open in an app that supports zip files."))
      .toBeVisible();
  });

  it("frames an HTML file stored with a generic type as HTML, in a sandbox", async () => {
    const file = new File(["<p>hi</p>"], "page.html", { type: "application/octet-stream" });
    await mount(
      <AttachmentFilePreview file={file} mimeType={file.type} name={file.name} sizeBytes={9} />,
    );
    const frame = page.getByTitle("page.html");
    await expect.element(frame).toBeVisible();
    const element = frame.element() as HTMLIFrameElement;
    // Never allow-same-origin: with scripts it would reach the client.
    expect(element.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms allow-popups allow-downloads",
    );
    expect((await (await fetch(element.src)).blob()).type).toBe("text/html");
  });

  it("frames only bytes that are a PDF in the unsandboxed PDF frame", async () => {
    const file = new File(["<script>1</script>"], "fake.pdf", { type: "application/pdf" });
    await mount(
      <AttachmentFilePreview file={file} mimeType={file.type} name={file.name} sizeBytes={18} />,
    );
    await expect.element(page.getByText("This file is not a PDF.")).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("offers a retry when a sent video's bytes do not play", async () => {
    const { loader, reads } = nodeLoader("not really a video");
    await mount(
      <AttachmentFilePreview
        loader={loader}
        mimeType="video/mp4"
        name="clip.mp4"
        sizeBytes={18}
        stored={stored("clip.mp4", "video/mp4", 18)}
      />,
    );
    // The bytes are no video: the element says so, with a way to try again.
    await expect.element(page.getByText("Unable to load video.")).toBeVisible();
    expect(reads).toEqual(["url att-1"]);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByText("Unable to load video.")).toBeVisible();
    expect(reads).toEqual(["url att-1", "url att-1"]);
  });
});
