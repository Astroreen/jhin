import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type MeshMember,
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

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const A = "ws://a/rpc";
const CLOSED = "ws://closed/rpc";
const LOADING = "ws://loading/rpc";

const connection = (id: string, state: NodeConnection["state"] = "open") =>
  ({ id, url: id, label: id, state, client: {} }) as unknown as NodeConnection;
const member = (nodeId: string, extra: Partial<MeshMember> = {}): MeshMember => ({
  nodeId,
  name: nodeId,
  self: false,
  reachable: true,
  ...extra,
});
const project = (id: string, extra: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id,
  name: id,
  path: `/work/${id}`,
  scratch: false,
  createdAt: ago(200),
  ...extra,
});
const scratch = project("scratch", { name: "No project", scratch: true });
const thread = (
  id: string,
  projectId: string,
  createdAt: string,
  extra: Partial<ThreadRecord> = {},
) => ({ id, projectId, title: id, createdAt, ...extra }) satisfies ThreadRecord;

/** Node a (open, with mesh member b), a closed connection and one whose catalog is loading. */
function world() {
  const connections: Connections = {
    list: () => [connection(A), connection(CLOSED, "closed"), connection(LOADING)],
    get: (id) => connections.list().find((node) => node.id === id),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
  const mesh: MeshMembership = {
    members: (id) =>
      id === A
        ? [member("a", { self: true }), member("b"), member("gone", { reachable: false })]
        : [],
    subscribe: () => toDisposable(() => undefined),
  };
  const catalogs = new Map<string, NodeCatalog>([
    [
      targetKey({ node: A }),
      {
        status: "ready",
        projects: [scratch, project("web")],
        threads: [
          thread("t-old", "web", ago(10), {
            lastTurn: { turnId: "u", status: "completed", at: ago(9), agentId: "x" },
          }),
          thread("t-new", "scratch", ago(1)),
          thread("t-settled", "web", ago(100), {
            lastTurn: { turnId: "u", status: "completed", at: ago(90), agentId: "x" },
            settledOverride: "settled",
            settledAt: ago(90),
          }),
        ],
      },
    ],
    [
      targetKey({ node: A, remote: "b" }),
      { status: "ready", projects: [scratch], threads: [thread("t-b", "scratch", ago(5))] },
    ],
  ]);
  const loading: NodeCatalog = { status: "loading", projects: [], threads: [] };
  const listeners = new Set<() => void>();
  const threads = {
    catalog: (target: NodeTarget) => catalogs.get(targetKey(target)) ?? loading,
    subscribe: (_target: NodeTarget, listener: () => void) => {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as unknown as ThreadsCatalog;
  /** A target's catalog arrives, as the threads store reports it. */
  const load = (target: NodeTarget, catalog: NodeCatalog) => {
    catalogs.set(targetKey(target), catalog);
    for (const listener of Array.from(listeners)) listener();
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
  return { connections, mesh, threads, navigation, visited, load, listeners };
}

let kernel: TestKernel | undefined;
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
  localStorage.clear();
});

async function start(stored: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
  const w = world();
  kernel = await createTestKernel({
    side: "client",
    plugins: [
      mockCapability(UI_SLOTS_CAPABILITY, createSlotRegistry()),
      mockCapability(CONNECTIONS_CAPABILITY, w.connections),
      mockCapability(NAVIGATION_CAPABILITY, w.navigation),
      mockCapability(MESH_CAPABILITY, w.mesh),
      mockCapability(THREADS_CAPABILITY, w.threads),
      sidebarPlugin,
    ],
  });
  const run = (name: string, input: unknown = {}) => kernel!.commands.execute(name, input);
  return { ...w, run };
}

describe("chat.new", () => {
  it("waits for a loading node's projects, then starts the draft in its scratch project", async () => {
    const { run, navigation, visited, load, listeners } = await start();
    navigation.navigate({ node: LOADING });
    const started = run("chat.new");
    load({ node: LOADING }, { status: "ready", projects: [scratch], threads: [] });
    await started;
    expect(visited).toEqual([{ node: LOADING }, { node: LOADING, project: "scratch" }]);
    expect(listeners.size).toBe(0);
  });
});

describe("chat.new-without-project (D72)", () => {
  it("starts a draft in the scratch project of a named node, or of a member of its mesh", async () => {
    const { run, visited } = await start();
    await run("chat.new-without-project", { node: A });
    await run("chat.new-without-project", { node: A, remote: "b" });
    expect(visited).toEqual([
      { node: A, project: "scratch" },
      { node: A, remote: "b", project: "scratch" },
    ]);
  });

  it("takes a remote only with the node whose mesh reaches it", async () => {
    const { run, visited } = await start();
    for (const name of ["chat.new-without-project", "project.add"]) {
      await expect(run(name, { remote: "b" })).rejects.toMatchObject({
        code: "COMMAND_INPUT_INVALID",
        details: { issues: [expect.objectContaining({ path: "remote" })] },
      });
    }
    expect(visited).toEqual([]);
  });

  it("refuses a node that is not connected, not open or not reachable", async () => {
    const { run, visited } = await start();
    await expect(
      run("chat.new-without-project", { node: "ws://nobody/rpc" }),
    ).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    });
    await expect(run("chat.new-without-project", { node: CLOSED })).rejects.toMatchObject({
      code: "NODE_UNAVAILABLE",
    });
    await expect(
      run("chat.new-without-project", { node: A, remote: "gone" }),
    ).rejects.toMatchObject({ code: "NODE_UNAVAILABLE" });
    await expect(run("project.add", { node: CLOSED })).rejects.toMatchObject({
      code: "NODE_UNAVAILABLE",
    });
    // No made-up project: a node whose projects are not loaded yet says so.
    await expect(run("chat.new-without-project", { node: LOADING })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    expect(visited).toEqual([]);
  });

  it("uses the current place's node without input, the first open one when there is none", async () => {
    const { run, visited } = await start();
    await run("chat.new-without-project", {});
    expect(visited).toEqual([{ node: A, project: "scratch" }]);
  });
});

describe("the sidebar's thread shortcuts follow its list (D70)", () => {
  it("count active threads newest-created first across nodes, and no collapsed settled thread", async () => {
    const { run, visited } = await start();
    for (const jump of [1, 2, 3, 4]) await run(`sidebar.thread.jump.${jump}`);
    expect(visited).toEqual([
      { node: A, thread: "t-new" },
      { node: A, remote: "b", thread: "t-b" },
      { node: A, thread: "t-old" },
    ]);
    await run("sidebar.thread.previous");
    expect(visited.at(-1)).toEqual({ node: A, remote: "b", thread: "t-b" });
    await run("sidebar.thread.next");
    expect(visited.at(-1)).toEqual({ node: A, thread: "t-old" });
  });

  it("count settled threads once the shelf, kept on the device, is open", async () => {
    const { run, visited } = await start({ "jhin.sidebar.settled-expanded": "true" });
    await run("sidebar.thread.jump.4");
    expect(visited).toEqual([{ node: A, thread: "t-settled" }]);
  });

  it("keep to the project filter kept on the device", async () => {
    const { run, visited } = await start({
      "jhin.sidebar.project-scope": JSON.stringify(`${targetKey({ node: A })}|web`),
    });
    await run("sidebar.thread.jump.1");
    expect(visited).toEqual([{ node: A, thread: "t-old" }]);
  });

  it("ignore stored values that are corrupt or of the wrong type", async () => {
    for (const stored of [
      { "jhin.sidebar.settled-expanded": '"yes"', "jhin.sidebar.project-scope": "5" },
      { "jhin.sidebar.settled-expanded": "{", "jhin.sidebar.project-scope": "{" },
      // A project that went away no longer narrows the list.
      { "jhin.sidebar.project-scope": JSON.stringify("ws://a/rpc|gone") },
    ]) {
      const { run, visited } = await start(stored);
      await run("sidebar.thread.jump.1");
      await run("sidebar.thread.jump.4");
      // All projects, settled shelf collapsed: the newest thread, and no fourth row.
      expect(visited).toEqual([{ node: A, thread: "t-new" }]);
      await kernel!.stop();
      kernel = undefined;
      localStorage.clear();
    }
  });
});
