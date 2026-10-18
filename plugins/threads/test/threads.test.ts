import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  type TestPlugin,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import agent from "../../agent-fake/src/index.ts";
import threads from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function node(options: { agent?: boolean; runtime?: unknown } = {}) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-threads-"));
  const storage = memoryStoragePlugin();
  const plugins: TestPlugin[] = [
    mockCapability("host.paths", {
      home: data,
      dataDir: (id: string) => {
        Fs.mkdirSync(Path.join(data, id), { recursive: true });
        return Path.join(data, id);
      },
    }),
    storage,
    { manifest: manifest("threads"), definition: threads },
  ];
  if (options.runtime !== undefined) plugins.push(mockCapability("agent.runtime", options.runtime));
  else if (options.agent !== false)
    plugins.push({ manifest: manifest("agent-fake"), definition: agent });
  const kernel = await createTestKernel({ plugins });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  stops.push(async () => {
    client.close();
    await kernel.stop();
  });
  return { kernel, client, data };
}

/** Subscribes to a thread; `until(type)` resolves with the first event of that type (seen or future). */
function watch(client: RpcClient, threadId: string) {
  const events: StoredEvent[] = [];
  const waiters: { type: string; resolve: (event: StoredEvent) => void }[] = [];
  client.subscribe(`thread/${threadId}`, {}, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.type === event.type)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  const until = (type: string, skip = 0) => {
    const seen = events.filter((event) => event.type === type)[skip];
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<StoredEvent>((resolve) => waiters.push({ type, resolve }));
  };
  return { events, until };
}

describe("jhin.threads", () => {
  it("has a scratch project and validates new project paths", async () => {
    const { client, data } = await node();

    const [scratch] =
      await client.call<{ id: string; scratch: boolean; path: string }[]>("projects.list");
    expect(scratch).toMatchObject({ id: "scratch", name: "No project", scratch: true });
    expect(Fs.statSync(scratch!.path).isDirectory()).toBe(true);
    await expect(
      client.call("projects.create", { name: "x", path: "relative/dir" }),
    ).rejects.toMatchObject({
      code: "PROJECT_PATH_INVALID",
    });
    const project = await client.call<{ id: string }>("projects.create", {
      name: "Data",
      path: data,
    });
    expect(
      await client.call("threads.create", { projectId: project.id, title: "T" }),
    ).toMatchObject({
      projectId: project.id,
      title: "T",
    });
    await expect(client.call("threads.create", { projectId: "nope" })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("runs a full turn and records it as events with the agent's id", async () => {
    const { client } = await node();
    const thread = await client.call<{ id: string; projectId: string }>("threads.create", {});
    expect(thread.projectId).toBe("scratch");
    const { events, until } = watch(client, thread.id);

    const { turnId } = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text: "hello world",
    });
    await until("agent.turn.completed");

    expect(events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "agent.turn.started",
      "agent.item.delta",
      "agent.item.delta",
      "agent.item.delta",
      "agent.item.completed",
      "agent.turn.completed",
    ]);
    expect(events[1]?.payload).toEqual({
      turnId,
      agentId: "jhin.agent-fake",
      input: { text: "hello world" },
    });
    expect(
      events
        .filter((event) => event.type === "agent.item.delta")
        .map((event) => (event.payload as { text: string }).text)
        .join(""),
    ).toBe("Echo: hello world");
    expect(events[5]?.payload).toMatchObject({
      turnId,
      kind: "message",
      text: "Echo: hello world",
    });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("allows one turn at a time and interrupts a streaming turn", async () => {
    const { client } = await node();
    const thread = await client.call<{ id: string }>("threads.create", {});
    const { until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await until("agent.item.delta");
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "again" }),
    ).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
    });
    expect(await client.call("threads.interrupt", { threadId: thread.id })).toEqual({
      interrupted: true,
    });
    await until("agent.turn.interrupted");

    expect(await client.call("threads.interrupt", { threadId: thread.id })).toEqual({
      interrupted: false,
    });
    await client.call("threads.send", { threadId: thread.id, text: "after" });
    await until("agent.turn.completed");
  });

  it("records a failing turn and needs an agent runtime to send", async () => {
    const { client } = await node();
    const thread = await client.call<{ id: string }>("threads.create", {});
    const { until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/fail please" });
    expect((await until("agent.turn.failed")).payload).toMatchObject({
      error: expect.stringContaining("asked to fail"),
    });

    const bare = await node({ agent: false });
    const other = await bare.client.call<{ id: string }>("threads.create", {});
    await expect(
      bare.client.call("threads.send", { threadId: other.id, text: "hi" }),
    ).rejects.toMatchObject({
      code: "NO_AGENT",
    });
  });

  it("closes a turn whose agent fails to start and keeps the thread usable", async () => {
    const { client } = await node({
      runtime: {
        agentId: "acme.broken",
        startTurn() {
          throw new Error("cannot start");
        },
      },
    });
    const thread = await client.call<{ id: string }>("threads.create", {});
    const { events, until } = watch(client, thread.id);

    await expect(client.call("threads.send", { threadId: thread.id, text: "hi" })).rejects.toThrow(
      "cannot start",
    );
    await until("agent.turn.failed");

    expect(events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "agent.turn.started",
      "agent.turn.failed",
    ]);
    expect(
      (await client.call<{ running?: string }>("threads.get", { threadId: thread.id })).running,
    ).toBeUndefined();
  });

  it("stores project paths normalised", async () => {
    const { client, data } = await node();

    const project = await client.call<{ path: string }>("projects.create", {
      name: "x",
      path: `${data}/sub/../`,
    });

    expect(project.path).toBe(data);
  });
});
