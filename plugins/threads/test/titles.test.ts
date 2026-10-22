// Regenerating a thread's title (docs/plans/t3-parity.md, D1174, D1175).
import type { AgentItem, AgentRuntime } from "@jhin/agent-api";
import { memoryStoragePlugin } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { formatThreadTitleContext, limitTitleMessage } from "../src/title.ts";
import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  title: string;
  titleRegeneration?: { requestedAt: string };
}

/** A runtime that answers threads as the fake does, and holds a title prompt until `release`. */
function heldWriter() {
  let release!: (answer: string) => void;
  const answered = new Promise<string>((resolve) => (release = resolve));
  let asked!: () => void;
  const askedOnce = new Promise<void>((resolve) => (asked = resolve));
  const runtime: AgentRuntime = {
    agentId: "acme.writer",
    startTurn(request) {
      async function* items(): AsyncGenerator<AgentItem> {
        if (request.input.text.startsWith("Regenerate the title")) {
          asked();
          yield { kind: "message.completed", itemId: "w", text: await answered };
          return;
        }
        yield { kind: "message.completed", itemId: `${request.turnId}:1`, text: "ok" };
      }
      return { items: items(), interrupt() {} };
    },
  };
  return { runtime, release, askedOnce };
}

describe("jhin.threads: regenerating a title (D1174, D1175)", () => {
  it("has the thread's agent write it from the thread's messages", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const events = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "fix the flaky login" });
    await events.until("agent.turn.completed");

    const first = await client.call("threads.title.regenerate", { threadId: thread.id });
    expect(first).toEqual({ title: "About fix the flaky login", changed: true });
    const read = await client.call<{ thread: Thread }>("threads.get", { threadId: thread.id });
    expect(read.thread.title).toBe("About fix the flaky login");
    expect(read.thread.titleRegeneration).toBeUndefined();
    // The same title again changes nothing.
    expect(await client.call("threads.title.regenerate", { threadId: thread.id })).toEqual({
      title: "About fix the flaky login",
      changed: false,
    });
  });

  it("refuses a thread without messages, and one whose title is being written", async () => {
    const writer = heldWriter();
    const storage = memoryStoragePlugin();
    const first = await node({ runtime: writer.runtime, storage });
    const empty = await first.client.call<Thread>("threads.create", {});
    await expect(
      first.client.call("threads.title.regenerate", { threadId: empty.id }),
    ).rejects.toMatchObject({ code: "TITLE_UNAVAILABLE" });

    const thread = await first.client.call<Thread>("threads.create", {});
    const events = watch(first.client, thread.id);
    await first.client.call("threads.send", { threadId: thread.id, text: "go" });
    await events.until("agent.turn.completed");
    const pending = first.client.call("threads.title.regenerate", { threadId: thread.id });
    await writer.askedOnce;
    const during = await first.client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(during.thread.titleRegeneration).toEqual({ requestedAt: expect.any(String) });
    await expect(
      first.client.call("threads.title.regenerate", { threadId: thread.id }),
    ).rejects.toMatchObject({ code: "TITLE_REGENERATING" });

    // An answer without a title keeps the title, and the thread is free again.
    writer.release("no idea");
    await expect(pending).rejects.toMatchObject({ code: "TITLE_UNAVAILABLE" });
    const after = await first.client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(after.thread).toMatchObject({ title: "go" });
    expect(after.thread.titleRegeneration).toBeUndefined();
  });

  it("clears a title a stopped node was writing", async () => {
    const writer = heldWriter();
    const storage = memoryStoragePlugin();
    const first = await node({ runtime: writer.runtime, storage });
    const thread = await first.client.call<Thread>("threads.create", {});
    const events = watch(first.client, thread.id);
    await first.client.call("threads.send", { threadId: thread.id, text: "go" });
    await events.until("agent.turn.completed");
    void first.client.call("threads.title.regenerate", { threadId: thread.id }).catch(() => {});
    await writer.askedOnce;
    await first.stop();

    const second = await node({ runtime: heldWriter().runtime, storage });
    const read = await second.client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(read.thread.titleRegeneration).toBeUndefined();
  });
});

describe("the thread's contents a title reads (T3's formatThreadTitleContext)", () => {
  it("keeps the first and the latest messages within the budget, saying what was cut", () => {
    const long = "x".repeat(3_000);
    const text = formatThreadTitleContext([
      { role: "user", text: "first ask" },
      ...Array.from({ length: 6 }, (_, index) => ({
        role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
        text: `${index} ${long}`,
      })),
      { role: "user", text: "latest ask", attachments: ["shot.png"] },
    ]);
    expect(text.startsWith("[Earlier content truncated]")).toBe(true);
    expect(text).toContain("USER:\nfirst ask");
    expect(text).toContain("USER:\nlatest ask\n[Attachments: shot.png]");
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(limitTitleMessage("abcdefghijklmnopqrstuvwxyz".repeat(4), 40)).toContain(
      "[Content truncated]",
    );
  });
});
