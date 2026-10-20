import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";
import { createMemoryStorage, type EventLog } from "@jhin/storage-api";
import { testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import { node } from "./support.ts";

interface ThreadRecord {
  id: string;
  projectId: string;
  title: string;
}

/** Makes the next append to `stream` fail, as a full disk would. */
function failNextAppend(log: EventLog, stream: string) {
  const append = log.append.bind(log);
  log.append = async (name, events, options) => {
    if (name !== stream) return append(name, events, options);
    log.append = append;
    throw new Error("disk full");
  };
}

describe("thread and project records (D207, D208)", () => {
  it("creates a thread with an id the caller chose once, however often it is asked", async () => {
    const { client, storage } = await node();

    const [first, again, concurrent] = await Promise.all([
      client.call<ThreadRecord>("threads.create", { threadId: "t-1", title: "One" }),
      client.call<ThreadRecord>("threads.create", { threadId: "t-1", title: "One" }),
      client.call<ThreadRecord>("threads.create", { threadId: "t-1", title: "Other title" }),
    ]);

    expect(first).toMatchObject({ id: "t-1", projectId: "scratch", title: "One" });
    expect(again).toEqual(first);
    expect(concurrent).toEqual(first);
    expect(await client.call<ThreadRecord>("threads.create", { threadId: "t-1" })).toEqual(first);
    const index = await storage.storage.log.read(THREADS_STREAM);
    expect(index.filter((event) => event.type === ThreadEvents.threadCreated)).toHaveLength(1);
    expect(await storage.storage.log.read("thread/t-1")).toHaveLength(1);
  });

  it("refuses an id taken in another project, or by a deleted thread", async () => {
    const { client, data } = await node();
    const project = await client.call<{ id: string }>("projects.create", { path: data });
    await client.call("threads.create", { threadId: "taken" });

    await expect(
      client.call("threads.create", { threadId: "taken", projectId: project.id }),
    ).rejects.toMatchObject({ code: "THREAD_EXISTS" });
    await client.call("threads.delete", { threadId: "taken" });
    await expect(client.call("threads.create", { threadId: "taken" })).rejects.toMatchObject({
      code: "THREAD_EXISTS",
    });
    await expect(client.call("threads.create", { threadId: "../x" })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
  });

  it("finishes a creation that stopped after the thread's first event", async () => {
    const { client, storage } = await node();
    failNextAppend(storage.storage.log, THREADS_STREAM);
    await expect(
      client.call("threads.create", { threadId: "half", title: "Half" }),
    ).rejects.toThrow();
    expect(await client.call<ThreadRecord[]>("threads.list", {})).toEqual([]);

    const thread = await client.call<ThreadRecord>("threads.create", {
      threadId: "half",
      title: "Asked again",
    });

    // The thread its stream recorded, not a second one.
    expect(thread).toMatchObject({ id: "half", title: "Half" });
    expect(await storage.storage.log.read("thread/half")).toHaveLength(1);
    expect(await client.call<ThreadRecord[]>("threads.list", {})).toEqual([thread]);
  });

  it("writes no record whose index event could not be written", async () => {
    const { client, storage, data } = await node();
    const thread = await client.call<ThreadRecord>("threads.create", { title: "Before" });
    const project = await client.call<{ id: string }>("projects.create", { name: "P", path: data });
    const head = await storage.storage.log.head(THREADS_STREAM);

    failNextAppend(storage.storage.log, THREADS_STREAM);
    await expect(
      client.call("threads.update", { threadId: thread.id, title: "After" }),
    ).rejects.toThrow("disk full");
    failNextAppend(storage.storage.log, THREADS_STREAM);
    await expect(
      client.call("projects.update", { projectId: project.id, name: "Renamed" }),
    ).rejects.toThrow("disk full");

    const catalog = await client.call<{
      head: number;
      threads: ThreadRecord[];
      projects: { id: string; name: string }[];
    }>("threads.catalog", {});
    expect(catalog.head).toBe(head);
    expect(catalog.threads.find((item) => item.id === thread.id)?.title).toBe("Before");
    expect(catalog.projects.find((item) => item.id === project.id)?.name).toBe("P");
  });

  it("removes a project and announces it in one write", async () => {
    const { client, storage, data } = await node();
    const project = await client.call<{ id: string }>("projects.create", { path: data });

    failNextAppend(storage.storage.log, THREADS_STREAM);
    await expect(client.call("projects.delete", { projectId: project.id })).rejects.toThrow();
    expect(
      (await client.call<{ id: string }[]>("projects.list", {})).map((item) => item.id),
    ).toContain(project.id);
    await client.call("projects.delete", { projectId: project.id });
    expect(
      (await client.call<{ id: string }[]>("projects.list", {})).map((item) => item.id),
    ).toEqual(["scratch"]);
    const index = await storage.storage.log.read(THREADS_STREAM);
    expect(index.filter((event) => event.type === ThreadEvents.projectDeleted)).toHaveLength(1);
  });

  it("takes the thread another process made with the id meanwhile", async () => {
    const { client, storage } = await node();
    const log = storage.storage.log;
    const append = log.append.bind(log);
    log.append = async (stream, events, options) => {
      if (stream === "thread/raced" && options?.expectedHead === 0) {
        log.append = append;
        // Another process sharing the storage creates the thread first.
        await append(stream, [
          {
            type: ThreadEvents.threadCreated,
            payload: {
              id: "raced",
              projectId: "scratch",
              title: "Theirs",
              createdAt: new Date().toISOString(),
            },
          },
        ]);
      }
      return append(stream, events, options);
    };

    const thread = await client.call<ThreadRecord>("threads.create", {
      threadId: "raced",
      title: "Mine",
    });
    expect(thread).toMatchObject({ id: "raced", title: "Theirs" });
    expect(await storage.storage.log.read("thread/raced")).toHaveLength(1);
  });

  it("refuses to start when the event log writes its records elsewhere", async () => {
    const kv = createMemoryStorage();
    const log = createMemoryStorage();
    const mixed = {
      manifest: testManifest("mock.mixed-storage", {
        provides: { "storage.kv": "1.0.0", "storage.eventlog": "1.1.0" },
      }),
      definition: definePlugin({
        activate(context) {
          context.services.provide("storage.kv", kv.kv);
          context.services.provide("storage.eventlog", log.log);
        },
      }),
    };
    const { client } = await node({ storage: Object.assign(mixed, { storage: kv }) });
    await expect(client.call("threads.list", {})).rejects.toMatchObject({
      code: expect.stringMatching(/COMMAND_NOT_FOUND|UNKNOWN_COMMAND|METHOD_NOT_FOUND/),
    });
  });
});
