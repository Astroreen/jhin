import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { createTestKernel, memoryStoragePlugin, mockCapability } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import threads from "../src/index.ts";
import { manifest, node, stops, watch } from "./support.ts";

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

  it("lists threads made before the index existed in the threads stream", async () => {
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-threads-"));
    const storage = memoryStoragePlugin();
    const old = {
      id: "t-old",
      projectId: "scratch",
      title: "Old",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await storage.storage.kv.set("jhin.threads", "thread/t-old", old);
    const kernel = await createTestKernel({
      plugins: [
        mockCapability("host.paths", { home: data, dataDir: () => data }),
        storage,
        { manifest: manifest("threads"), definition: threads },
      ],
    });
    stops.push(() => kernel.stop());

    expect((await storage.storage.log.read("threads")).map((event) => event.payload)).toEqual([
      old,
    ]);
  });
});
