import { describe, expect, it } from "vite-plus/test";

import { createAttachmentUrls, downloadAttachment, uploadAttachment } from "../src/lib/uploads.ts";

/** A node keeping uploads in memory, as `attachments.*` does. */
function fakeNode() {
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string; sizeBytes: number }>();
  const calls: string[] = [];
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const input = params as Record<string, unknown>;
    calls.push(method);
    if (method === "attachments.begin") {
      const id = `att-${blobs.size}`;
      blobs.set(id, {
        bytes: new Uint8Array(),
        mimeType: String(input.mimeType),
        sizeBytes: Number(input.sizeBytes),
      });
      return { attachmentId: id } as T;
    }
    const blob = blobs.get(String(input.attachmentId))!;
    if (method === "attachments.write") {
      expect(input.offset).toBe(blob.bytes.length);
      blob.bytes = Buffer.concat([blob.bytes, Buffer.from(String(input.data), "base64")]);
      return { received: blob.bytes.length } as T;
    }
    const offset = Number(input.offset ?? 0);
    const part = blob.bytes.slice(offset, offset + 1024 * 1024);
    return {
      data: Buffer.from(part).toString("base64"),
      mimeType: blob.mimeType,
      done: offset + part.length >= blob.sizeBytes,
    } as T;
  };
  return { call, calls, blobs };
}

describe("uploads (D292)", () => {
  it("uploads in chunks with progress and reads the same bytes back", async () => {
    const node = fakeNode();
    const bytes = Uint8Array.from({ length: 1_600_000 }, (_, index) => index % 251);
    const file = new File([bytes], "data.bin", { type: "application/octet-stream" });
    const progress: number[] = [];
    const stored = await uploadAttachment(node.call, file, "file", (share) => progress.push(share));
    expect(stored).toEqual({
      kind: "file",
      id: "att-0",
      name: "data.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1_600_000,
    });
    expect(node.calls.filter((method) => method === "attachments.write")).toHaveLength(3);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));

    const back = new Uint8Array(await (await downloadAttachment(node.call, "att-0")).arrayBuffer());
    expect(Buffer.compare(back, bytes)).toBe(0);
  });

  it("stops an upload that was cancelled", async () => {
    const node = fakeNode();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadAttachment(node.call, new File(["x"], "a.txt"), "file", () => {}, controller.signal),
    ).rejects.toThrow("Upload cancelled");
  });

  it("loads each attachment once however many views ask, and again after a failure", async () => {
    const urls = createAttachmentUrls();
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads === 1) throw new Error("offline");
      return new Blob(["x"]);
    };
    await expect(urls.load("n|a", read)).rejects.toThrow("offline");
    const [first, second] = await Promise.all([urls.load("n|a", read), urls.load("n|a", read)]);
    expect(first).toBe(second);
    expect(reads).toBe(2);
    urls.dispose();
  });
});
