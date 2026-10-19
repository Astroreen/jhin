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
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_AGENT_ID,
  claudePlugin,
  createClaudeRuntime,
  type QueryFunction,
} from "../src/index.ts";
import {
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

/** Resolves with the thread's events once one of type `type` is recorded. */
function until(
  client: Awaited<ReturnType<typeof node>>["client"],
  threadId: string,
  type: string,
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  return new Promise((resolve) => {
    client.subscribe(`thread/${threadId}`, {}, (event) => {
      events.push(event);
      if (event.type === type) resolve(events);
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

    const second = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "Again?" });
    await second;
    expect(calls[1]!.options).toMatchObject({ resume: thread.id });
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
