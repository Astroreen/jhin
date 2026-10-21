import { fakeTurn } from "../../agent-fake/src/index.ts";

import type { AgentRegistry, AgentRuntime, TurnRequest } from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";
import { createMemoryStorage } from "@jhin/storage-api";
import { testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { createAttachments } from "../src/attachments.ts";
import { node, watch } from "./support.ts";

interface Begun {
  attachmentId: string;
}

const seen: TurnRequest[] = [];
const recording: AgentRuntime = {
  agentId: "acme.recording",
  startTurn(request) {
    seen.push(request);
    return fakeTurn(request);
  },
};
const registering = {
  manifest: testManifest("acme.recording", {
    side: "server",
    requires: { "agent.registry": "^1" },
  }),
  definition: definePlugin({
    activate(context) {
      context.subscriptions.add(
        context.services.get<AgentRegistry>("agent.registry").register(recording),
      );
    },
  }),
};

const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("jhin.threads: attachments as blobs (D291–D294)", () => {
  it("uploads in chunks, sends by id, gives the runtime the bytes and reads them back", async () => {
    seen.length = 0;
    const { client } = await node({ plugins: [registering] });
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: "acme.recording",
    });
    const { until } = watch(client, thread.id);

    const { attachmentId } = await client.call<Begun>("attachments.begin", {
      kind: "file",
      name: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
    });
    expect(
      await client.call("attachments.write", { attachmentId, offset: 0, data: base64("Hello") }),
    ).toEqual({ received: 5, complete: false });
    // A chunk sent twice is refused, not written twice.
    await expect(
      client.call("attachments.write", { attachmentId, offset: 0, data: base64("Hello") }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_OFFSET", details: { received: 5 } });
    const ref = { kind: "file", id: attachmentId, name: "x", mimeType: "x/y", sizeBytes: 12 };
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "early", attachments: [ref] }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_INCOMPLETE",
      message: "Attachment 'notes.md' did not finish uploading.",
    });
    expect(
      await client.call("attachments.write", { attachmentId, offset: 5, data: base64(", world") }),
    ).toEqual({ received: 12, complete: true });
    await expect(
      client.call("attachments.write", { attachmentId, offset: 12, data: base64("!") }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });

    await client.call("threads.send", { threadId: thread.id, text: "read it", attachments: [ref] });
    // The event holds the node's record of it, by id: no bytes.
    expect((await until("agent.turn.started")).payload).toMatchObject({
      input: {
        attachments: [
          {
            kind: "file",
            id: attachmentId,
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 12,
          },
        ],
      },
    });
    await until("agent.turn.completed");
    const given = seen[0]!.input.attachments![0]!;
    expect("read" in given && Buffer.from(await given.read()).toString()).toBe("Hello, world");
    // Memory storage keeps no files: no path.
    expect("path" in given).toBe(false);

    const read = await client.call<{ data: string; done: boolean }>("attachments.read", {
      attachmentId,
      offset: 7,
      length: 3,
    });
    expect(Buffer.from(read.data, "base64").toString()).toBe("wor");
    expect(read.done).toBe(false);

    // Sent again to the same thread (a retry) it goes; to another thread it is not found.
    await client.call("threads.send", { threadId: thread.id, text: "again", attachments: [ref] });
    await until("agent.turn.completed", 1);
    const other = await client.call<{ id: string }>("threads.create", {});
    await expect(
      client.call("threads.send", { threadId: other.id, text: "steal", attachments: [ref] }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    // Sent, it can no longer be discarded or written to.
    expect(await client.call("attachments.discard", { attachmentId })).toEqual({
      discarded: false,
    });

    // Deleting the thread deletes its attachments.
    await client.call("threads.delete", { threadId: thread.id });
    await expect(client.call("attachments.read", { attachmentId })).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
    });
  });

  it("claims uploads sent through the queue too, and the queued turn reads them", async () => {
    seen.length = 0;
    const { client } = await node({ plugins: [registering] });
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: "acme.recording",
    });
    const { until } = watch(client, thread.id);
    const { attachmentId } = await client.call<Begun>("attachments.begin", {
      kind: "file",
      name: "q.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
    });
    await client.call("attachments.write", { attachmentId, offset: 0, data: base64("ok") });
    await client.call("threads.queue.add", {
      threadId: thread.id,
      text: "queued",
      attachments: [
        { kind: "file", id: attachmentId, name: "q.txt", mimeType: "text/plain", sizeBytes: 2 },
      ],
    });
    await until("agent.turn.completed");
    const given = seen[0]!.input.attachments![0]!;
    expect("read" in given && Buffer.from(await given.read()).toString()).toBe("ok");
    // Claimed when queued: a sweep or another thread can no longer take it.
    expect(await client.call("attachments.discard", { attachmentId })).toEqual({
      discarded: false,
    });
  });

  it("names a queued upload by id in the queue's event, so a client can show its thumbnail", async () => {
    const { client } = await node();
    const thread = await client.call<{ id: string }>("threads.create", {});
    const watched = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await watched.until("agent.item.delta");
    const { attachmentId } = await client.call<Begun>("attachments.begin", {
      kind: "image",
      name: "dot.png",
      mimeType: "image/png",
      sizeBytes: 3,
    });
    await client.call("attachments.write", { attachmentId, offset: 0, data: base64("png") });
    const image = { kind: "image", id: attachmentId, name: "dot.png", mimeType: "image/png" };
    await client.call("threads.queue.add", {
      threadId: thread.id,
      text: "",
      attachments: [{ ...image, sizeBytes: 3 }],
      messageId: "m-1",
    });
    const updated = await watched.until("threads.queue.updated");
    expect(updated.payload).toMatchObject({
      messages: [{ id: "m-1", attachments: [{ ...image, sizeBytes: 3 }] }],
    });
    // The id reads the queued image back.
    const read = await client.call<{ data: string }>("attachments.read", { attachmentId });
    expect(Buffer.from(read.data, "base64").toString()).toBe("png");
  });

  it("refuses what T3 refuses: unsupported images, too large files, too many", async () => {
    const { client } = await node();
    await expect(
      client.call("attachments.begin", {
        kind: "image",
        name: "a.bmp",
        mimeType: "image/bmp",
        sizeBytes: 10,
      }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_TYPE",
      message:
        "'a.bmp' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.",
    });
    await expect(
      client.call("attachments.begin", {
        kind: "file",
        name: "big.zip",
        mimeType: "application/zip",
        sizeBytes: 50 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
      message: "'big.zip' exceeds the 50 MB attachment limit.",
    });
    await expect(
      client.call("attachments.begin", {
        kind: "image",
        name: "big.png",
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    const thread = await client.call<{ id: string }>("threads.create", {});
    const many = Array.from({ length: 101 }, (_, index) => ({
      kind: "file",
      id: `att-00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      name: "x",
      mimeType: "text/plain",
      sizeBytes: 1,
    }));
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "x", attachments: many }),
    ).rejects.toThrow();
    const { attachmentId } = await client.call<Begun>("attachments.begin", {
      kind: "file",
      name: "gone.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    });
    expect(await client.call("attachments.discard", { attachmentId })).toEqual({ discarded: true });
    await expect(client.call("attachments.read", { attachmentId })).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
    });
  });

  it("sweeps uploads not sent within a day, never sent ones", async () => {
    const storage = createMemoryStorage();
    let now = new Date("2026-10-20T12:00:00.000Z");
    const store = createAttachments({
      kv: storage.kv,
      blobs: storage.blobs,
      namespace: "jhin.threads",
      now: () => now,
      queued: (_id, task) => task(),
      log: () => undefined,
    });
    const commands = new Map<string, (input: unknown) => Promise<unknown>>();
    store.register({
      register: (definition: { name: string; handler: (input: never) => unknown }) => {
        commands.set(definition.name, async (input) => definition.handler(input as never));
        return { dispose() {} };
      },
    } as never);
    const begin = async (name: string) =>
      (
        (await commands.get("attachments.begin")!({
          kind: "file",
          name,
          mimeType: "text/plain",
          sizeBytes: 1,
        })) as Begun
      ).attachmentId;
    const old = await begin("old.txt");
    const sent = await begin("sent.txt");
    await commands.get("attachments.write")!({ attachmentId: sent, offset: 0, data: base64("x") });
    await store.claim("t1", [
      { kind: "file", id: sent, name: "sent.txt", mimeType: "text/plain", sizeBytes: 1 },
    ]);
    now = new Date("2026-10-21T12:00:01.000Z");
    const fresh = await begin("fresh.txt");

    // The upload that began a day later swept already; a sweep now finds the same.
    await store.sweep();
    const left = (await storage.kv.list("jhin.threads", { prefix: "attachment/" })).map(
      (entry) => (entry.value as { id: string }).id,
    );
    expect(left.toSorted()).toEqual([fresh, sent].toSorted());
    expect(left).not.toContain(old);
  });

  it("takes no uploads on a node without storage.blobs", async () => {
    const storage = createMemoryStorage();
    const store = createAttachments({
      kv: storage.kv,
      blobs: undefined,
      namespace: "jhin.threads",
      now: () => new Date(),
      queued: (_id, task) => task(),
      log: () => undefined,
    });
    await expect(
      store.claim("t1", [
        {
          kind: "file",
          id: "att-00000000-0000-0000-0000-000000000000",
          name: "x",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ]),
    ).rejects.toMatchObject({
      code: "ATTACHMENTS_UNAVAILABLE",
      message: "This node does not support file attachments.",
    });
  });
});
