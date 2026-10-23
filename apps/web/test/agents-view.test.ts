import {
  AGENTS_STREAM,
  AgentEvents,
  THREADS_STREAM,
  ThreadEvents,
  type AgentRecord,
  type AgentStatus,
} from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  defineInput,
  draftOf,
  draftProblem,
  updateInput,
} from "../src/plugins/agents/definition.ts";
import { agentFormRoute, agentRoute, parseAgentSection } from "../src/plugins/agents/route.ts";
import {
  applyAgentEvent,
  applyThreadEvent,
  createAgentsStore,
  generationRows,
  generationsKey,
  statusOf,
  type NodeAgents,
} from "../src/plugins/agents/store.ts";

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  agentId: "builder",
  address: "jhin://n/agents/builder",
  kind: "defined",
  title: "Builder",
  role: "Builds",
  runtimeId: "jhin.agent-fake",
  skills: [],
  projectId: "scratch",
  generations: [{ number: 1, threadId: "t1", startedAt: "2026-10-21T00:00:00.000Z" }],
  ...overrides,
});
const ready: NodeAgents = { status: "ready", agents: [], read: {}, turns: {} };

describe("the agents of a node", () => {
  it("follows the agents stream: defined, updated, removed", () => {
    let state = applyAgentEvent(ready, { type: AgentEvents.defined, payload: agent() });
    state = applyAgentEvent(state, {
      type: AgentEvents.defined,
      payload: agent({ agentId: "analyst", title: "Analyst" }),
    });
    expect(state.agents.map((item) => item.agentId)).toEqual(["analyst", "builder"]);
    state = applyAgentEvent(state, {
      type: AgentEvents.updated,
      payload: agent({ role: "Reviews" }),
    });
    expect(state.agents.find((item) => item.agentId === "builder")?.role).toBe("Reviews");
    state = { ...state, read: { analyst: "idle" } };
    state = applyAgentEvent(state, { type: AgentEvents.removed, payload: { agentId: "analyst" } });
    expect(state.agents.map((item) => item.agentId)).toEqual(["builder"]);
    expect(state.read).toEqual({});
    // A generation, a stop and a resume come with `updated`: their own events change nothing.
    expect(applyAgentEvent(state, { type: AgentEvents.stopped, payload: {} })).toBe(state);
    expect(applyAgentEvent(state, { type: AgentEvents.updated, payload: null })).toBe(state);
  });

  it("takes the status from the record, the node's read and the generation's thread (D608, D616)", () => {
    const state = { ...ready, agents: [agent()] };
    expect(statusOf(agent(), state)).toBe("idle");
    // Before its thread changes, the node's own answer stands.
    expect(statusOf(agent(), { ...state, read: { builder: "working" } })).toBe("working");
    const running = applyThreadEvent(state, {
      type: ThreadEvents.threadUpdated,
      payload: { id: "t1", generationOf: "builder", lastTurn: { status: "running" } },
    });
    expect(statusOf(agent(), running)).toBe("working");
    const waiting = applyThreadEvent(running, {
      type: ThreadEvents.threadUpdated,
      payload: { id: "t1", generationOf: "builder", lastTurn: { status: "waiting" } },
    });
    expect(statusOf(agent(), waiting)).toBe("waiting");
    const done = applyThreadEvent(waiting, {
      type: ThreadEvents.threadUpdated,
      payload: { id: "t1", generationOf: "builder", lastTurn: { status: "completed" } },
    });
    expect(statusOf(agent(), { ...done, read: { builder: "working" } })).toBe("idle");
    // Threads that are no generation are none of its business.
    expect(
      applyThreadEvent(waiting, {
        type: ThreadEvents.threadUpdated,
        payload: { id: "t2", lastTurn: { status: "running" } },
      }),
    ).toBe(waiting);
    // Stopped and unavailable come before the thread.
    expect(statusOf(agent({ stoppedAt: "2026-10-21T01:00:00.000Z" }), waiting)).toBe("stopped");
    expect(statusOf(agent(), { ...waiting, read: { builder: "unavailable" } })).toBe("unavailable");
    const { projectId: _projectId, ...homeless } = agent();
    expect(statusOf(homeless, waiting)).toBe("unavailable");
  });
});

describe("an agent's route (D615)", () => {
  it("names the agent and, for an earlier one, the generation in the section", () => {
    expect(agentRoute("n", "builder")).toEqual({
      node: "n",
      mode: "civilization",
      panel: "agent",
      section: "builder",
    });
    expect(agentRoute("n", "builder", 2).section).toBe("builder/2");
    expect(parseAgentSection("builder")).toEqual({ agentId: "builder" });
    expect(parseAgentSection("builder/2")).toEqual({ agentId: "builder", generation: 2 });
    expect(parseAgentSection("builder/0")).toBeUndefined();
    expect(parseAgentSection("../x")).toBeUndefined();
    expect(parseAgentSection(undefined)).toBeUndefined();
  });
});

/** A connection whose node answers the agents commands and records its streams. */
function fakeNode(agents: AgentRecord[], statuses: Record<string, AgentStatus>) {
  const streams = new Map<string, { after?: number; onEvent: (event: StoredEvent) => void }>();
  const calls: string[] = [];
  let bothFollowed: () => void = () => undefined;
  /** Resolves once both streams are followed. */
  const followed = new Promise<void>((resolve) => (bothFollowed = resolve));
  const client = {
    call: async (method: string, params: { agentId?: string }) => {
      calls.push(method === "agents.get" ? `${method} ${params.agentId}` : method);
      if (method === "threads.catalog") return { head: 7, projects: [], threads: [] };
      if (method === "agents.catalog") return { head: 4, agents };
      if (method === "agents.get") {
        const found = agents.find((item) => item.agentId === params.agentId);
        return { ...found, status: statuses[params.agentId ?? ""] ?? "idle" };
      }
      throw new Error(`unexpected ${method}`);
    },
    subscribe(stream: string, options: { after?: number }, onEvent: (event: StoredEvent) => void) {
      streams.set(stream, { ...options, onEvent });
      if (streams.size === 2) bothFollowed();
      return { lastSequence: 0, dispose: () => streams.delete(stream) };
    },
  } as unknown as RpcClient;
  const connection: NodeConnection = {
    id: "ws://a/rpc",
    url: "ws://a/rpc",
    label: "a",
    client,
    state: "open",
  };
  const connections: Connections = {
    list: () => [connection],
    get: (id) => (id === connection.id ? connection : undefined),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
  const event = (stream: string, type: string, payload: unknown) =>
    streams.get(stream)?.onEvent({ type, payload } as unknown as StoredEvent);
  return { connections, streams, calls, event, followed };
}

/** Resolves once the store's state of the node satisfies `test`. */
function until(
  store: ReturnType<typeof createAgentsStore>,
  test: (state: NodeAgents | undefined) => boolean,
): Promise<NodeAgents> {
  return new Promise((resolve) => {
    const check = () => {
      const state = store.snapshot().get("ws://a/rpc");
      if (!test(state)) return false;
      subscription.dispose();
      resolve(state!);
      return true;
    };
    const subscription = store.subscribe(() => void check());
    check();
  });
}

describe("the agents store", () => {
  it("reads the catalog and each agent, then follows both streams after their heads", async () => {
    const node = fakeNode([agent()], { builder: "working" });
    const store = createAgentsStore(node.connections, { warn: () => undefined });
    const keep = store.subscribe(() => undefined);
    const state = await until(store, (known) => known?.read.builder !== undefined);
    expect(statusOf(agent(), state)).toBe("working");
    await node.followed;
    expect(node.streams.get(AGENTS_STREAM)?.after).toBe(4);
    expect(node.streams.get(THREADS_STREAM)?.after).toBe(7);

    // The turn ends: the index says so.
    node.event(THREADS_STREAM, ThreadEvents.threadUpdated, {
      id: "t1",
      generationOf: "builder",
      lastTurn: { status: "completed" },
    });
    expect(statusOf(agent(), store.snapshot().get("ws://a/rpc")!)).toBe("idle");

    // A changed agent is read again.
    node.event(AGENTS_STREAM, AgentEvents.updated, agent({ stoppedAt: "2026-10-21T02:00:00Z" }));
    const stopped = store.snapshot().get("ws://a/rpc")!;
    expect(statusOf(stopped.agents[0]!, stopped)).toBe("stopped");
    expect(node.calls.filter((call) => call === "agents.get builder")).toHaveLength(2);
    keep.dispose();
    store.dispose();
    expect(node.streams.size).toBe(0);
  });
});

describe("an agent's definition from the client (C1, D1065)", () => {
  const record = {
    agentId: "builder",
    address: "jhin://a/agents/builder",
    kind: "defined",
    title: "builder",
    role: "Builds",
    runtimeId: "fake",
    skills: ["tdd"],
    generations: [],
  } as AgentRecord;

  it("defines what the form sets, and nothing it leaves empty", () => {
    const draft = { ...draftOf(), agentId: " reviewer ", role: "Reviews", runtime: "fake" };
    expect(draftProblem(draft, true)).toBeUndefined();
    expect(defineInput({ ...draft, skills: "a, b\nc" })).toEqual({
      agentId: "reviewer",
      role: "Reviews",
      runtime: "fake",
      skills: ["a", "b", "c"],
    });
    expect(draftProblem({ ...draft, agentId: "Bad Id" }, true)).toMatch(/lowercase/);
    expect(draftProblem({ ...draft, role: " " }, true)).toMatch(/role/);
    expect(draftProblem({ ...draft, runtime: "" }, false)).toMatch(/runtime/);
  });

  it("updates only what changed, and unsets what was emptied", () => {
    const draft = draftOf(record);
    // A title equal to the id was never set.
    expect(draft.title).toBe("");
    expect(updateInput(record, draft)).toBeUndefined();
    expect(updateInput(record, { ...draft, role: "Builds well", skills: "", model: "m" })).toEqual({
      agentId: "builder",
      role: "Builds well",
      model: "m",
      unset: ["skills"],
    });
  });

  it("unsets an emptied title, project or instructions, and sets a new runtime", () => {
    const full = { ...record, title: "Builder", projectId: "p1", instructions: "Be brief." };
    const draft = draftOf(full);
    expect(draft).toMatchObject({ title: "Builder", project: "p1", instructions: "Be brief." });
    expect(
      updateInput(full, { ...draft, title: " ", project: "", instructions: "", runtime: "other" }),
    ).toEqual({
      agentId: "builder",
      runtime: "other",
      unset: ["title", "instructions", "project"],
    });
    // Whitespace around a field is not a change.
    expect(updateInput(full, { ...draft, role: " Builds " })).toBeUndefined();
  });

  it("opens the form of a new agent or of one to edit", () => {
    expect(agentFormRoute("a")).toEqual({
      node: "a",
      mode: "civilization",
      panel: "agent-definition",
    });
    expect(agentFormRoute("a", "builder")).toEqual({
      node: "a",
      mode: "civilization",
      panel: "agent-definition",
      section: "builder",
    });
  });
});

describe("D1272: a generation's own status in the page's list", () => {
  const two = agent({
    generations: [
      { number: 1, threadId: "t1", startedAt: "2026-10-21T00:00:00.000Z" },
      { number: 2, threadId: "t2", startedAt: "2026-10-22T00:00:00.000Z" },
    ],
  });

  it("lists the newest first with each status and marks the current one", () => {
    const rows = generationRows(
      two,
      new Map<string, AgentStatus>([
        ["t1", "idle"],
        ["t2", "working"],
      ]),
    );
    expect(rows.map((row) => [row.generation.number, row.current, row.status])).toEqual([
      [2, true, "working"],
      [1, false, "idle"],
    ]);
  });

  it("keeps the list without statuses before the answer or when the call failed", () => {
    for (const statuses of [undefined, new Map<string, AgentStatus>()]) {
      const rows = generationRows(two, statuses);
      expect(rows.map((row) => [row.generation.number, row.current])).toEqual([
        [2, true],
        [1, false],
      ]);
      expect(rows.every((row) => row.status === undefined)).toBe(true);
    }
  });

  it("asks again when a turn of one of its generations, or its stop, changes", () => {
    const key = (state: NodeAgents, record = two) => generationsKey(record, state);
    const before = key(ready);
    expect(key({ ...ready, turns: { other: "running" as never } })).toBe(before);
    expect(key({ ...ready, turns: { t1: "running" as never } })).not.toBe(before);
    expect(key(ready, { ...two, stoppedAt: "2026-10-23T00:00:00.000Z" })).not.toBe(before);
  });
});

describe("the agents store starts a broken feed over (D1387)", () => {
  /** A node whose `agents.catalog` fails with `codes` in turn, then answers. */
  function flaky(codes: (string | undefined)[]) {
    const streams = new Map<string, { onError?: (error: Error) => void; onEvent: unknown }>();
    let asked = 0;
    /** Resolves once both streams are followed, again after each start over. */
    let followed = new Promise<void>(() => undefined);
    let notify: () => void = () => undefined;
    const rearm = () => (followed = new Promise<void>((resolve) => (notify = resolve)));
    rearm();
    const client = {
      call: async (method: string) => {
        if (method === "threads.catalog") return { head: 1, projects: [], threads: [] };
        if (method === "agents.get") return { ...agent(), status: "idle" };
        if (method !== "agents.catalog") throw new Error(`unexpected ${method}`);
        asked += 1;
        if (codes.length > 0) {
          const code = codes.shift();
          throw Object.assign(new Error("catalog is down"), code === undefined ? {} : { code });
        }
        return { head: 4, agents: [agent()] };
      },
      subscribe(stream: string, options: { onError?: (error: Error) => void }, onEvent: unknown) {
        streams.set(stream, { ...options, onEvent });
        if (streams.size === 2) notify();
        return { lastSequence: 0, dispose: () => streams.delete(stream) };
      },
    } as unknown as RpcClient;
    const connection: NodeConnection = {
      id: "ws://a/rpc",
      url: "ws://a/rpc",
      label: "a",
      client,
      state: "open",
    };
    const connections: Connections = {
      list: () => [connection],
      get: (id) => (id === connection.id ? connection : undefined),
      add: () => {
        throw new Error("not used");
      },
      remove: () => undefined,
      subscribe: () => toDisposable(() => undefined),
    };
    return { connections, streams, asked: () => asked, followed: () => followed };
  }

  /** The store's timers, run by the test: `pending` holds what waits, with its pause. */
  function timers() {
    const pending: { run: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      pending,
      delay: (run: () => void, ms: number) => {
        const timer = { run, ms, cancelled: false };
        pending.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      /** Runs the oldest timer still waiting. */
      fire() {
        const timer = pending.find((item) => !item.cancelled);
        if (timer === undefined) throw new Error("nothing waits");
        timer.cancelled = true;
        timer.run();
      },
      waiting: () => pending.filter((item) => !item.cancelled).map((item) => item.ms),
    };
  }

  const open = (node: ReturnType<typeof flaky>, clock: ReturnType<typeof timers>) => {
    const store = createAgentsStore(node.connections, { warn: () => undefined }, clock.delay);
    const keep = store.subscribe(() => undefined);
    return { store, keep };
  };
  const state = (store: ReturnType<typeof createAgentsStore>) => store.snapshot().get("ws://a/rpc");

  it("retries after growing pauses, keeps the agents shown, and resets once the feed delivers", async () => {
    const node = flaky([undefined, undefined, undefined]);
    const clock = timers();
    const { store, keep } = open(node, clock);
    await until(store, (known) => known?.status === "error");
    expect(clock.waiting()).toEqual([1000]);

    clock.fire();
    await until(store, (known) => known?.status === "error" && node.asked() === 2);
    expect(clock.waiting()).toEqual([2000]);
    clock.fire();
    await until(store, (known) => known?.status === "error" && node.asked() === 3);
    expect(clock.waiting()).toEqual([4000]);
    clock.fire();
    // The fourth attempt reads: ready, and no retry waits.
    const loaded = await until(store, (known) => known?.status === "ready");
    expect(loaded.agents.map((item) => item.agentId)).toEqual(["builder"]);
    expect(clock.waiting()).toEqual([]);

    // A stream that breaks before delivering anything keeps growing the pause; the agents stay shown.
    await node.followed();
    node.streams.get(AGENTS_STREAM)?.onError?.(new Error("closed"));
    expect(state(store)?.status).toBe("error");
    expect(state(store)?.agents).toHaveLength(1);
    expect(clock.waiting()).toEqual([8000]);
    keep.dispose();
    store.dispose();
  });

  it("starts the pause over when the feed delivered an event", async () => {
    const node = flaky([undefined]);
    const clock = timers();
    const { store, keep } = open(node, clock);
    await until(store, (known) => known?.status === "error");
    clock.fire();
    await until(store, (known) => known?.status === "ready");
    await node.followed();
    const deliver = node.streams.get(AGENTS_STREAM)?.onEvent as (event: StoredEvent) => void;
    deliver({ type: AgentEvents.stopped, payload: {} } as unknown as StoredEvent);
    node.streams.get(AGENTS_STREAM)?.onError?.(new Error("closed"));
    expect(clock.waiting()).toEqual([1000]);
    keep.dispose();
    store.dispose();
  });

  it("does not retry a node without the command or the permission, and stops on dispose", async () => {
    const missing = flaky(["COMMAND_NOT_FOUND"]);
    const clock = timers();
    const first = open(missing, clock);
    await until(first.store, (known) => known?.status === "unsupported");
    expect(clock.waiting()).toEqual([]);
    first.keep.dispose();
    first.store.dispose();

    const down = flaky([undefined, undefined]);
    const later = timers();
    const second = open(down, later);
    await until(second.store, (known) => known?.status === "error");
    expect(later.waiting()).toEqual([1000]);
    second.store.dispose();
    expect(later.waiting()).toEqual([]);
    expect(down.asked()).toBe(1);
  });

  it("caps the pause, and Retry means now with the pause reset", async () => {
    const node = flaky(Array.from({ length: 9 }, () => undefined));
    const clock = timers();
    const { store, keep } = open(node, clock);
    await until(store, (known) => known?.status === "error");
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      clock.fire();
      await until(store, (known) => known?.status === "error" && node.asked() === attempt);
    }
    // 1, 2, 4, 8, 16, 32 seconds, then the cap.
    expect(clock.waiting()).toEqual([60_000]);

    store.refresh("ws://a/rpc");
    expect(clock.waiting()).toEqual([]);
    await until(store, (known) => known?.status === "error" && node.asked() === 9);
    expect(clock.waiting()).toEqual([1000]);
    keep.dispose();
    store.dispose();
  });
});
