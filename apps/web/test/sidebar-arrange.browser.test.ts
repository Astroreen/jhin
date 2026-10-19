import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type MeshMembership,
  type Navigation,
  type NodeCatalog,
  type NodeConnection,
  type NodeTarget,
  type ProjectRecord,
  type Route,
  type ThreadRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { createTestKernel, mockCapability, type TestKernel } from "@jhin/testing";
import { UI_SLOTS_CAPABILITY, createSlotRegistry } from "@jhin/ui";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { sidebarPlugin } from "../src/plugins/sidebar.tsx";
import { threadActionsPlugin } from "../src/plugins/thread-actions.tsx";

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const A = "ws://a/rpc";

const project: ProjectRecord = {
  id: "web",
  name: "web",
  path: "/work/web",
  scratch: false,
  createdAt: ago(200),
};
const done = (hours: number) => ({
  turnId: "u",
  status: "completed" as const,
  at: ago(hours),
  agentId: "x",
});

/**
 * One node whose threads change as the threads plugin's arrangement commands
 * say (D75–D78), recording every call.
 */
function world(threads: ThreadRecord[]) {
  const connection = {
    id: A,
    url: A,
    label: A,
    state: "open",
    client: {},
  } as unknown as NodeConnection;
  const connections: Connections = {
    list: () => [connection],
    get: (id) => (id === A ? connection : undefined),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
  const mesh: MeshMembership = {
    members: () => [],
    subscribe: () => toDisposable(() => undefined),
  };
  let records = threads;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const now = () => new Date().toISOString();
  const change = (threadId: string, update: (thread: ThreadRecord) => ThreadRecord) => {
    records = records.map((thread) => (thread.id === threadId ? update(thread) : thread));
  };
  const catalog: ThreadsCatalog = {
    catalog: (target: NodeTarget): NodeCatalog =>
      targetKey(target) === A
        ? { status: "ready", projects: [project], threads: records }
        : { status: "loading", projects: [], threads: [] },
    subscribe: () => toDisposable(() => undefined),
    async call<T>(_target: NodeTarget, method: string, params?: unknown): Promise<T> {
      const input = params as Record<string, unknown> & { threadId: string };
      calls.push({ method, params: input });
      const { threadId } = input;
      switch (method) {
        case "threads.settle":
          change(threadId, ({ pinnedAt: _p, pinOrderKey: _k, ...thread }) => ({
            ...thread,
            settledOverride: "settled",
            settledAt: now(),
          }));
          break;
        case "threads.unsettle":
          change(threadId, ({ settledAt: _s, ...thread }) => ({
            ...thread,
            settledOverride: "active",
            unsettledAt: now(),
          }));
          break;
        case "threads.pin":
          change(threadId, (thread) => ({
            ...thread,
            pinnedAt: now(),
            ...(input.orderKey === undefined ? {} : { pinOrderKey: input.orderKey as string }),
          }));
          break;
        case "threads.unpin":
          change(threadId, ({ pinnedAt: _p, pinOrderKey: _k, ...thread }) => thread);
          break;
        case "threads.reorder":
          change(threadId, (thread) => ({
            ...thread,
            [input.list === "pinned" ? "pinOrderKey" : "activeOrderKey"]: input.orderKey,
          }));
          break;
      }
      return undefined as T;
    },
    open: async () => "",
  };
  let route: Route = {};
  const visited: Route[] = [];
  const navigation: Navigation = {
    current: () => route,
    navigate(next) {
      route = next;
      visited.push(next);
    },
    subscribe: () => toDisposable(() => undefined),
  };
  return { connections, mesh, threads: catalog, navigation, visited, calls };
}

let kernel: TestKernel | undefined;
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
  localStorage.clear();
});

async function start(threads: ThreadRecord[], route: Route = {}) {
  const w = world(threads);
  w.navigation.navigate(route);
  w.visited.length = 0;
  kernel = await createTestKernel({
    side: "client",
    plugins: [
      mockCapability(UI_SLOTS_CAPABILITY, createSlotRegistry()),
      mockCapability(CONNECTIONS_CAPABILITY, w.connections),
      mockCapability(NAVIGATION_CAPABILITY, w.navigation),
      mockCapability(MESH_CAPABILITY, w.mesh),
      mockCapability(THREADS_CAPABILITY, w.threads),
      sidebarPlugin,
      threadActionsPlugin,
    ],
  });
  const run = (name: string, input: unknown = {}) => kernel!.commands.execute(name, input);
  return { ...w, run };
}

const thread = (id: string, createdHoursAgo: number, extra: Partial<ThreadRecord> = {}) =>
  ({
    id,
    projectId: "web",
    title: id,
    createdAt: ago(createdHoursAgo),
    lastTurn: done(createdHoursAgo - 0.5),
    ...extra,
  }) satisfies ThreadRecord;

describe("settling the open thread moves on to the next card (D75)", () => {
  it("settles through thread.park: the sidebar opens the card below, else above", async () => {
    const { run, visited, calls } = await start(
      [thread("top", 1), thread("middle", 2), thread("bottom", 3)],
      { node: A, thread: "middle" },
    );
    await run("thread.settle", { node: A, threadId: "middle" });
    expect(calls.map((call) => call.method)).toEqual(["threads.settle"]);
    expect(visited).toEqual([{ node: A, thread: "bottom" }]);

    await run("sidebar.thread.toggle-settled");
    // The last card settled: the one above it opens.
    expect(visited.at(-1)).toEqual({ node: A, thread: "top" });
  });

  it("leaves the route alone when the thread settled is not the open one", async () => {
    const { run, visited } = await start([thread("top", 1), thread("other", 2)], {
      node: A,
      thread: "top",
    });
    await run("thread.settle", { node: A, threadId: "other" });
    expect(visited).toEqual([]);
  });

  it("opens a new thread in the project when the last card settles", async () => {
    const { run, visited } = await start([thread("only", 1)], { node: A, thread: "only" });
    await run("sidebar.thread.toggle-settled");
    expect(visited).toEqual([{ node: A, project: "web" }]);
  });

  it("un-settles the open thread when it is settled", async () => {
    const { run, calls } = await start(
      [thread("quiet", 100, { settledOverride: "settled", settledAt: ago(50) })],
      { node: A, thread: "quiet" },
    );
    await run("sidebar.thread.toggle-settled");
    expect(calls.map((call) => call.method)).toEqual(["threads.unsettle"]);
  });

  it("toggles the open thread's pin", async () => {
    const { run, calls } = await start([thread("t", 1)], { node: A, thread: "t" });
    await run("sidebar.thread.toggle-pinned");
    await run("sidebar.thread.toggle-pinned");
    expect(calls.map((call) => call.method)).toEqual(["threads.pin", "threads.unpin"]);
  });
});

describe("moving a thread, as dropping it does (D78)", () => {
  it("pins a thread between the pinned ones with a key between theirs", async () => {
    const { run, calls } = await start([
      thread("p1", 5, { pinnedAt: ago(1), pinOrderKey: "c" }),
      thread("p2", 6, { pinnedAt: ago(1), pinOrderKey: "n" }),
      thread("a", 1),
    ]);
    await run("sidebar.thread.move", { node: A, threadId: "a", section: "pinned", index: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "threads.pin", params: { threadId: "a" } });
    const key = calls[0]!.params.orderKey as string;
    expect(key > "c" && key < "n").toBe(true);
  });

  it("un-settles a settled thread dropped among the active ones and orders the list", async () => {
    const { run, calls } = await start([
      thread("a1", 1),
      thread("a2", 2),
      thread("s", 200, { lastTurn: done(150) }),
    ]);
    await run("sidebar.thread.move", { node: A, threadId: "s", section: "active", index: 1 });
    expect(calls.map((call) => [call.method, call.params.threadId])).toEqual([
      ["threads.unsettle", "s"],
      ["threads.reorder", "a1"],
      ["threads.reorder", "s"],
      ["threads.reorder", "a2"],
    ]);
    const keys = calls.slice(1).map((call) => call.params.orderKey as string);
    expect(keys.toSorted()).toEqual(keys);
  });

  it("settles a thread moved to the shelf, and refuses a thread it does not show", async () => {
    const { run, calls } = await start([thread("a", 1)]);
    await run("sidebar.thread.move", { node: A, threadId: "a", section: "settled" });
    expect(calls.map((call) => call.method)).toEqual(["threads.settle"]);
    await expect(
      run("sidebar.thread.move", { node: A, threadId: "nope", section: "pinned" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });
});
