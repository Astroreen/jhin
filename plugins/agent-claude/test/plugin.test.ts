import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import threads from "@jhin/plugin-threads";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
} from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CLAUDE_AGENT_ID,
  claudePlugin,
  createClaudeRuntime,
  type Config,
  type QueryFunction,
} from "../src/index.ts";
import {
  drain,
  init,
  memorySessions,
  result,
  scriptedQuery,
  streamedBlock,
  toolResult,
  toolUse,
  type Script,
} from "./support.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function node(...scripts: Script[]) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-claude-"));
  const storage = memoryStoragePlugin();
  const { query, calls } = scriptedQuery(...scripts);
  const kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      storage,
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-claude"), definition: claudePlugin(query) },
    ],
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  stops.push(async () => {
    client.close();
    await kernel.stop();
  });
  return { client, calls, storage };
}

/** Resolves with the thread's events (all of them, from its start) once `count` of type `type` are recorded. */
function until(
  client: Awaited<ReturnType<typeof node>>["client"],
  threadId: string,
  type: string,
  count = 1,
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  return new Promise((resolve) => {
    client.subscribe(`thread/${threadId}`, {}, (event) => {
      events.push(event);
      if (events.filter((seen) => seen.type === type).length === count) resolve(events);
    });
  });
}

describe("jhin.agent-claude: the plugin", () => {
  it("registers Claude Code as an agent of the node", async () => {
    const { client } = await node();
    const agents = await client.call<{ agentId: string; name: string; models: { id: string }[] }[]>(
      "agents.list",
      {},
    );
    // No status probe in a test kernel would start Claude Code: the scripted query has no script.
    const claude = agents.find((agent) => agent.agentId === CLAUDE_AGENT_ID);
    expect(claude).toMatchObject({ name: "Claude Code" });
    expect(claude?.models.map((model) => model.id)).toContain("claude-fable-5-1");
  });

  it("runs a thread's turns on one Claude session, resumed on the next turn", async () => {
    const { client, calls } = await node(
      async function* () {
        yield init();
        yield toolUse("m1", "tool-1", "Read", { file_path: "/work/README.md" });
        yield toolResult("tool-1", "# Jhin");
        yield* streamedBlock("m2", 0, "text", ["It is ", "Jhin."]);
        yield result();
      },
      async function* () {
        yield init();
        yield* streamedBlock("m3", 0, "text", ["Again."]);
        yield result();
      },
    );
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CLAUDE_AGENT_ID,
    });

    const first = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "What is this?" });
    const events = await first;
    expect(events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "agent.turn.started",
      "agent.item.started",
      "agent.item.completed",
      "agent.usage.updated",
      "agent.item.delta",
      "agent.item.delta",
      "agent.item.completed",
      "agent.usage.updated",
      "agent.turn.completed",
    ]);
    expect(events.find((event) => event.type === "agent.item.started")?.payload).toMatchObject({
      kind: "tool",
      tool: { name: "Read", kind: "file_read", detail: "/work/README.md" },
    });
    expect(calls[0]!.options).toMatchObject({ sessionId: thread.id });

    const second = until(client, thread.id, "agent.turn.completed", 2);
    await client.call("threads.send", { threadId: thread.id, text: "Again?" });
    await second;
    expect(calls[1]!.options).toMatchObject({ resume: thread.id });
  });

  it("keeps the thread's Claude Code between turns until the thread is archived", async () => {
    const answering: Script = async function* (player) {
      yield init();
      yield result();
      while ((await player.nextPrompt()) !== undefined) {
        yield init();
        yield result();
      }
    };
    const { client, calls } = await node(answering);
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CLAUDE_AGENT_ID,
    });
    for (const [index, text] of ["one", "two"].entries()) {
      const completed = until(client, thread.id, "agent.turn.completed", index + 1);
      await client.call("threads.send", { threadId: thread.id, text });
      await completed;
    }
    expect(calls).toHaveLength(1);
    expect(await client.call("claude.sessions.list", {})).toEqual([
      expect.objectContaining({ threadId: thread.id, busy: false }),
    ]);

    // A rename is no archive: the session stays.
    await client.call("threads.update", { threadId: thread.id, title: "Renamed" });
    expect(await client.call("claude.sessions.list", {})).toHaveLength(1);
    expect(calls[0]!.closed).toBe(false);

    await client.call("threads.archive", { threadId: thread.id });
    await calls[0]!.whenClosed;
    expect(await client.call("claude.sessions.list", {})).toEqual([]);
  });

  it("ends a deleted thread's Claude Code and forgets its session", async () => {
    const { client, calls, storage } = await node(async function* (player) {
      yield init();
      yield result();
      await player.nextPrompt();
    });
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CLAUDE_AGENT_ID,
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    await completed;
    expect(await storage.storage.kv.get("jhin.agent-claude", `session/${thread.id}`)).toBeDefined();

    await client.call("threads.delete", { threadId: thread.id });
    await calls[0]!.whenClosed;
    expect(await client.call("claude.sessions.list", {})).toEqual([]);
    expect(
      await storage.storage.kv.get("jhin.agent-claude", `session/${thread.id}`),
    ).toBeUndefined();
  });

  it("ends live sessions on request", async () => {
    const { client, calls } = await node(async function* (player) {
      yield init();
      yield result();
      await player.nextPrompt();
    });
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CLAUDE_AGENT_ID,
    });
    const completed = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    await completed;
    expect(await client.call("claude.sessions.close", { threadId: "elsewhere" })).toEqual({
      closed: 0,
    });
    expect(await client.call("claude.sessions.close", {})).toEqual({ closed: 1 });
    expect(calls[0]!.closed).toBe(true);
  });

  it("records Claude Code's failure as a failed turn", async () => {
    const { client } = await node(async function* () {
      yield init();
      yield result({ is_error: true, api_error_status: 429, result: "rate limited" });
    });
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: CLAUDE_AGENT_ID,
    });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    expect((await failed).at(-1)?.payload).toMatchObject({
      error: expect.stringContaining("Claude API rate limit reached"),
    });
  });
});

describe("jhin.agent-claude: context window", () => {
  it("keeps the window Claude Code reported for a model the manifest does not know", async () => {
    const { query } = scriptedQuery(
      async function* () {
        yield init();
        yield result({ modelUsage: { "claude-new-6": { contextWindow: 400_000 } } });
      },
      async function* () {
        yield init();
        yield* streamedBlock("m1", 0, "text", ["ok"], { inputTokens: 1_000 });
        yield result({ modelUsage: {} });
      },
    );
    const claude = createClaudeRuntime({ query, sessions: memorySessions(), config: () => ({}) });
    const request = {
      threadId: "0b6c5e5e-0000-4000-8000-000000000002",
      input: { text: "hi" },
      history: [],
      cwd: "/work",
      model: "claude-new-6",
    };
    // `startTurn` works detached from its runtime, as a registry may call it.
    const { startTurn } = claude;
    const first = await drain(startTurn({ ...request, turnId: "t1" }));
    expect(first.at(-1)).toMatchObject({ kind: "usage", usage: { contextWindow: 400_000 } });
    const second = await drain(claude.startTurn({ ...request, turnId: "t2" }));
    expect(second[0]).toEqual({
      kind: "usage",
      usage: { inputTokens: 1_000, outputTokens: 0, contextTokens: 1_000, contextWindow: 400_000 },
    });
  });
});

describe("jhin.agent-claude: status", () => {
  /** A query that only initializes, as Claude Code does for the probe. */
  const initializing = (account: Record<string, unknown>, models: unknown[] = []) => {
    let closed = 0;
    const query = (() => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => undefined,
      close: () => void closed++,
      initializationResult: async () => ({ account, models }),
    })) as unknown as QueryFunction;
    return { query, closed: () => closed };
  };
  const runtime = (query: QueryFunction) =>
    createClaudeRuntime({ query, sessions: memorySessions(), config: () => ({}) });

  it("is available when signed in, with the account's models", async () => {
    const probe = initializing({ email: "ada@example.com", tokenSource: "claude.ai" }, [
      { value: "default", displayName: "Default" },
      { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Complex work" },
    ]);
    const claude = runtime(probe.query);
    expect(await claude.status!()).toEqual({
      available: true,
      message: "Signed in as ada@example.com",
    });
    expect(claude.models).toEqual([
      { id: "claude-opus-5-5", name: "Opus 5.5", description: "Complex work" },
    ]);
    expect(claude.defaultModel).toBe("claude-opus-5-5");
    expect(probe.closed()).toBe(1);
  });

  it("counts an account without fields as signed in, as T3 Code does", async () => {
    const claude = runtime(initializing({}).query);
    expect(await claude.status!()).toEqual({ available: true });
  });

  it("answers a stale status at once and probes again behind it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let signedIn = false;
      let probes = 0;
      let probed = Promise.resolve();
      const query = ((params: Parameters<QueryFunction>[0]) => {
        probes++;
        const running = initializing(
          signedIn ? { email: "ada@example.com" } : { tokenSource: "none" },
        ).query(params);
        // Settles once the probe closed its query and the runtime took its answer.
        probed = new Promise((resolve) => {
          const close = running.close.bind(running);
          running.close = () => {
            close();
            setImmediate(resolve);
          };
        });
        return running;
      }) as QueryFunction;
      const claude = runtime(query);
      expect(await claude.status!()).toMatchObject({ available: false });
      signedIn = true;
      // Fresh: reused as is.
      expect(await claude.status!()).toMatchObject({ available: false });
      expect(probes).toBe(1);
      // "Unavailable" is stale after 10 s: answered once more while the new probe runs.
      vi.setSystemTime(Date.now() + 10_000);
      expect(await claude.status!()).toMatchObject({ available: false });
      expect(probes).toBe(2);
      await probed;
      expect(await claude.status!()).toMatchObject({ available: true });
      // "Available" stays fresh for five minutes.
      vi.setSystemTime(Date.now() + 60_000);
      expect(await claude.status!()).toMatchObject({ available: true });
      expect(probes).toBe(2);
      vi.setSystemTime(Date.now() + 5 * 60_000);
      signedIn = false;
      expect(await claude.status!()).toMatchObject({ available: true });
      expect(probes).toBe(3);
      await probed;
      expect(await claude.status!()).toMatchObject({ available: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes again when the binary or the environment changes", async () => {
    let probes = 0;
    const query = ((params: Parameters<QueryFunction>[0]) => {
      probes++;
      return initializing({ email: "ada@example.com" }).query(params);
    }) as QueryFunction;
    let config: Config = {};
    const claude = createClaudeRuntime({ query, sessions: memorySessions(), config: () => config });
    await claude.status!();
    await claude.status!();
    expect(probes).toBe(1);
    config = { env: { CLAUDE_CONFIG_DIR: "/other" } };
    await claude.status!();
    expect(probes).toBe(2);
    // A config change while a probe runs starts a probe of its own instead of joining it.
    config = { env: { CLAUDE_CONFIG_DIR: "/a" } };
    const first = claude.status!();
    config = { env: { CLAUDE_CONFIG_DIR: "/b" } };
    const second = claude.status!();
    await Promise.all([first, second]);
    expect(probes).toBe(4);
  });

  it("is unavailable when Claude Code does not initialize in time", async () => {
    vi.useFakeTimers();
    try {
      let closed = 0;
      const query = (() => {
        // Like the SDK: closing the query rejects an initialization still waited for.
        let reject!: (error: Error) => void;
        const initialization = new Promise((_, fail) => (reject = fail));
        return {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
          interrupt: async () => undefined,
          close: () => {
            closed++;
            reject(new Error("Query closed before response received"));
          },
          initializationResult: () => initialization,
        };
      }) as unknown as QueryFunction;
      const status = runtime(query).status!();
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await status).toEqual({
        available: false,
        message: "Claude Code could not start: Claude Code did not start in time",
      });
      expect(closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is unavailable when Claude Code finds no token", async () => {
    const claude = runtime(initializing({ tokenSource: "none" }).query);
    expect(await claude.status!()).toMatchObject({ available: false });
    expect(claude.models?.map((model) => model.id)).toContain("claude-fable-5-1");
  });

  it("is unavailable when Claude Code does not start", async () => {
    const claude = runtime((() => {
      throw new Error("spawn claude ENOENT");
    }) as unknown as QueryFunction);
    expect(await claude.status!()).toEqual({
      available: false,
      message: "Claude Code could not start: spawn claude ENOENT",
    });
  });
});
