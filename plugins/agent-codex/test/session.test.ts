import type { AgentItem, TurnRequest } from "@jhin/agent-api";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CODEX_AGENT_ID,
  Config,
  createCodexRuntime,
  createSessions,
  launchAppServer,
  type Launcher,
  type ThreadStore,
} from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until, type FakeCodex, type Step } from "./support.ts";

afterEach(async () => {
  vi.useRealTimers();
  await stopAll();
});

/** The text of the nth turn/start Jhin sent. */
const turnText = (fake: FakeCodex, index: number) =>
  (fake.received("turn/start")[index]!.params!["input"] as { text: string }[])[0]!.text;

const message = (itemId: string, text: string): Step => ({
  notify: "item/completed",
  params: {
    threadId: "$thread",
    turnId: "$turn",
    item: { type: "agentMessage", id: itemId, text },
  },
});

async function send(
  client: Awaited<ReturnType<typeof node>>["client"],
  threadId: string,
  text: string,
  count: number,
) {
  const completed = until(client, threadId, "agent.turn.completed", count);
  await client.call("threads.send", { threadId, text });
  return completed;
}

describe("jhin.agent-codex: a Codex thread per thread", () => {
  it("keeps the app-server between turns and resumes the Codex thread on a new one", async () => {
    const fake = fakeCodex({});
    const { client, storage } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    await send(client, thread.id, "one", 1);
    await send(client, thread.id, "two", 2);
    expect(fake.received("thread/start")).toHaveLength(1);
    expect(fake.received("turn/start").map((turn) => turn.params?.["threadId"])).toEqual([
      "codex-thread-1",
      "codex-thread-1",
    ]);
    expect(await storage.storage.kv.get("jhin.agent-codex", `thread/${thread.id}`)).toMatchObject({
      codexThreadId: "codex-thread-1",
    });
    expect(await client.call("codex.sessions.list", {})).toEqual([
      expect.objectContaining({ threadId: thread.id, busy: false, model: "gpt-6-astra" }),
    ]);

    expect(await client.call("codex.sessions.close", { threadId: thread.id })).toEqual({
      closed: 1,
    });
    await send(client, thread.id, "three", 3);
    expect(fake.received("thread/resume")[0]?.params).toMatchObject({
      threadId: "codex-thread-1",
      excludeTurns: true,
    });
    // The resumed thread saw the earlier turns: no transcript.
    expect(fake.received("turn/start")[2]?.params).toMatchObject({
      input: [{ type: "text", text: "three" }],
    });
  });

  it("starts a new Codex thread with a transcript when Codex has nothing to resume", async () => {
    const fake = fakeCodex({
      turns: [[message("m1", "First answer"), { complete: "completed" }]],
      errors: { "thread/resume": [{ message: "no rollout found for thread id codex-thread-1" }] },
    });
    const { client, storage } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    await send(client, thread.id, "one", 1);
    await client.call("codex.sessions.close", {});
    await send(client, thread.id, "two", 2);
    expect(fake.received("thread/start")).toHaveLength(2);
    const text = turnText(fake, 1);
    expect(text).toContain("This thread started before you joined it.");
    expect(text).toContain("User: one\nAssistant: First answer");
    expect(text.endsWith("two")).toBe(true);
    expect(await storage.storage.kv.get("jhin.agent-codex", `thread/${thread.id}`)).toMatchObject({
      codexThreadId: "codex-thread-2",
    });
  });

  it("unarchives an archived Codex session before resuming it", async () => {
    const fake = fakeCodex({
      errors: { "thread/resume": [{ message: "session codex-thread-1 is archived" }] },
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    await send(client, thread.id, "one", 1);
    await client.call("codex.sessions.close", {});
    await send(client, thread.id, "two", 2);
    expect(fake.received("thread/unarchive")[0]?.params).toEqual({ threadId: "codex-thread-1" });
    expect(fake.received("thread/resume")).toHaveLength(2);
    expect(fake.received("thread/start")).toHaveLength(1);
  });

  it("ends the app-server of an archived thread and forgets a deleted thread's Codex thread", async () => {
    const fake = fakeCodex({});
    const { client, storage } = await node(fake);
    const archived = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
    });
    const deleted = await client.call<{ id: string }>("threads.create", {
      agentId: CODEX_AGENT_ID,
    });
    await send(client, archived.id, "one", 1);
    await send(client, deleted.id, "one", 1);
    expect(await client.call("codex.sessions.list", {})).toHaveLength(2);

    await client.call("threads.archive", { threadId: archived.id });
    expect(await client.call("codex.sessions.list", {})).toEqual([
      expect.objectContaining({ threadId: deleted.id }),
    ]);
    await client.call("threads.delete", { threadId: deleted.id });
    expect(await client.call("codex.sessions.list", {})).toEqual([]);
    expect(
      await storage.storage.kv.get("jhin.agent-codex", `thread/${deleted.id}`),
    ).toBeUndefined();
  });

  it("ends an idle app-server after the idle minutes, and keeps it with 0", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = fakeCodex({});
    const { client, kernel } = await node(fake, { sessionIdleMinutes: 2 });
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    await send(client, thread.id, "one", 1);
    vi.advanceTimersByTime(60_000);
    expect(await client.call("codex.sessions.list", {})).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(await client.call("codex.sessions.list", {})).toEqual([]);

    kernel.config.setLayer("node", {
      "jhin.agent-codex": { ...fake.config, sessionIdleMinutes: 0 },
    });
    await send(client, thread.id, "two", 2);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(await client.call("codex.sessions.list", {})).toHaveLength(1);
  });

  it("keeps the app-server when only the node's own environment changes", async () => {
    const fake = fakeCodex({});
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    await send(client, thread.id, "one", 1);
    process.env["JHIN_CODEX_TEST_VARIABLE"] = "changed";
    try {
      await send(client, thread.id, "two", 2);
    } finally {
      delete process.env["JHIN_CODEX_TEST_VARIABLE"];
    }
    expect(fake.processes()).toHaveLength(1);
  });

  it("starts Codex again with CODEX_HOME when the home changes", async () => {
    const fake = fakeCodex({});
    const { client, kernel } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    await send(client, thread.id, "one", 1);
    kernel.config.setLayer("node", {
      "jhin.agent-codex": { ...fake.config, homePath: "/work/codex-home", args: ["-c", "x=1"] },
    });
    await send(client, thread.id, "two", 2);
    const started = fake.log().filter((entry) => entry["started"] !== undefined);
    expect(started.at(-1)).toMatchObject({
      started: ["app-server", "-c", "x=1"],
      home: "/work/codex-home",
    });
    expect(fake.received("thread/resume")).toHaveLength(1);
  });

  it("fails a turn whose Codex does not start with why, not as a takeover", async () => {
    const fake = fakeCodex({});
    const { client } = await node(fake, {
      binaryPath: "/nonexistent/codex",
      defaultModel: "gpt-6-astra",
    });
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    const error = String(payloads(await failed, "agent.turn.failed")[0]?.["error"]);
    expect(error).toContain("Could not start Codex CLI (`/nonexistent/codex`)");
    expect(error).not.toContain("took its Codex over");
  });

  it("passes only the node's variables the allow-list names", async () => {
    const fake = fakeCodex({});
    process.env["JHIN_NODE_SECRET"] = "secret";
    try {
      const { client } = await node(fake, { inheritEnv: ["PATH", "FAKE_*"], defaultModel: "m" });
      const thread = await client.call<{ id: string }>("threads.create", {
        agentId: CODEX_AGENT_ID,
      });
      await send(client, thread.id, "hi", 1);
    } finally {
      delete process.env["JHIN_NODE_SECRET"];
    }
    expect(fake.log().find((entry) => entry["started"] !== undefined)).toMatchObject({
      sawSecret: false,
    });
  });

  it("ends busy app-servers too with force, and fails their turn", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "Working" },
          },
          { hang: true },
        ],
      ],
    });
    const { client } = await node(fake, { defaultModel: "m" });
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until(client, thread.id, "agent.item.delta");
    expect(await client.call("codex.sessions.close", {})).toEqual({ closed: 0 });
    expect(await client.call("codex.sessions.close", { force: true })).toEqual({ closed: 1 });
    expect(payloads(await failed, "agent.turn.failed")[0]).toMatchObject({
      error: expect.stringContaining("Codex was ended"),
    });
    expect(await client.call("codex.sessions.list", {})).toEqual([]);
  });

  it("fails the turn when Codex exits mid-turn, and starts it again for the next", async () => {
    const fake = fakeCodex({ turns: [[{ exit: 3 }], [{ complete: "completed" }]] });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "one" });
    expect(payloads(await failed, "agent.turn.failed")[0]).toMatchObject({
      error: expect.stringContaining("Codex exited while the turn was running."),
    });
    await send(client, thread.id, "two", 1);
    expect(fake.received("thread/resume")).toHaveLength(1);
  });

  it("fails a stopped turn that Codex had failed", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "Working" },
          },
          { waitForInterrupt: true },
          { complete: "failed", error: { message: "Quota exceeded" } },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until(client, thread.id, "agent.item.delta");
    await client.call("threads.interrupt", { threadId: thread.id });
    expect(payloads(await failed, "agent.turn.failed")[0]).toMatchObject({
      error: expect.stringContaining("Quota exceeded"),
    });
  });

  it("interrupts a running turn and keeps the app-server", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "Working" },
          },
          { waitForInterrupt: true },
          // What Codex still sends after the interrupt is not recorded.
          message("m1", "Working on it"),
          { complete: "interrupted" },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const interrupted = until(client, thread.id, "agent.turn.interrupted");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until(client, thread.id, "agent.item.delta");
    await client.call("threads.interrupt", { threadId: thread.id });
    const events = await interrupted;
    expect(payloads(events, "agent.item.completed")).toEqual([]);
    expect(await client.call("codex.sessions.list", {})).toEqual([
      expect.objectContaining({ threadId: thread.id, busy: false }),
    ]);
    expect(fake.processes()).toHaveLength(1);
  });
});

describe("jhin.agent-codex: stopping and ending", () => {
  it("fails the turn and keeps the record when resuming fails for another reason", async () => {
    const fake = fakeCodex({
      errors: { "thread/resume": [{ message: "session config file not found" }] },
    });
    const { client, storage } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    await send(client, thread.id, "one", 1);
    await client.call("codex.sessions.close", {});
    const failed = until(client, thread.id, "agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "two" });
    expect(payloads(await failed, "agent.turn.failed")[0]).toMatchObject({
      error: expect.stringContaining("session config file not found"),
    });
    expect(fake.received("thread/start")).toHaveLength(1);
    expect(await storage.storage.kv.get("jhin.agent-codex", `thread/${thread.id}`)).toMatchObject({
      codexThreadId: "codex-thread-1",
    });
  });

  it("ends the turn after the grace when Codex refuses the interrupt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "Working" },
          },
          { hang: true },
        ],
      ],
      errors: { "turn/interrupt": [{ message: "cannot interrupt" }] },
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const interrupted = until(client, thread.id, "agent.turn.interrupted");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until(client, thread.id, "agent.item.delta");
    await client.call("threads.interrupt", { threadId: thread.id });
    // Codex said no: Jhin waits for its turn/completed, then the grace ends the turn.
    vi.advanceTimersByTime(10_000);
    await interrupted;
    expect(await client.call("codex.sessions.list", {})).toEqual([]);
  });

  it("ends the turn and its app-server when Codex never completes an interrupted turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "Working" },
          },
          { hang: true },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const interrupted = until(client, thread.id, "agent.turn.interrupted");
    await client.call("threads.send", { threadId: thread.id, text: "go" });
    await until(client, thread.id, "agent.item.delta");
    await client.call("threads.interrupt", { threadId: thread.id });
    vi.advanceTimersByTime(10_000);
    await interrupted;
    expect(await client.call("codex.sessions.list", {})).toEqual([]);
  });

  it("keeps reading when a notification handler throws", async () => {
    const fake = fakeCodex({});
    const logged: string[] = [];
    const connection = launchAppServer({
      ...fake.config,
      args: [],
      cwd: process.cwd(),
      env: { ...process.env, ...fake.config.env },
      log: (line) => logged.push(line),
    });
    stopConnection(connection);
    let failed!: () => void;
    const thrown = new Promise<void>((resolve) => (failed = resolve));
    connection.onNotification(() => {
      failed();
      throw new Error("unreadable payload");
    });
    await connection.request("initialize", {});
    // The fake ends its turn with a turn/completed notification at once.
    await connection.request("turn/start", { threadId: "t" });
    await thrown;
    expect(await connection.request("thread/start", {})).toEqual({
      thread: { id: "codex-thread-1" },
    });
    expect(logged).toContain("a codex notification could not be handled");
  });

  it("kills a Codex that ignores SIGTERM", async () => {
    const fake = fakeCodex({ ignoreSigterm: true });
    const connection = launchAppServer({
      ...fake.config,
      args: [],
      cwd: process.cwd(),
      env: { ...process.env, ...fake.config.env },
      forceKillAfterMs: 50,
    });
    // Answered once the process runs and has set up its SIGTERM handler.
    await connection.request("initialize", {});
    connection.close();
    expect(await connection.exited).toMatchObject({ signal: "SIGKILL" });
    expect(fake.log().some((entry) => entry["ignored"] === "SIGTERM")).toBe(true);
  });
});

/** The runtime alone, on the fake, with thread records in memory. */
function runtime(fake: FakeCodex) {
  const records = new Map<string, string>();
  const threads: ThreadStore = {
    get: async (threadId) => records.get(threadId),
    set: async (threadId, id) => void records.set(threadId, id),
    delete: async (threadId) => void records.delete(threadId),
  };
  const codex = createCodexRuntime({ threads, config: () => Config.parse(fake.config) });
  return { codex, records };
}

const turnRequest = (overrides: Partial<TurnRequest> = {}): TurnRequest => ({
  threadId: "thread-1",
  turnId: "turn-a",
  input: { text: "hello" },
  history: [],
  cwd: process.cwd(),
  ...overrides,
});

async function collect(items: AsyncIterable<AgentItem>) {
  const seen: AgentItem[] = [];
  for await (const item of items) seen.push(item);
  return seen;
}

describe("jhin.agent-codex: frames of a turn", () => {
  it("takes frames that come before turn/start answers, and drops other turns' and threads'", async () => {
    const fake = fakeCodex({
      turns: [
        [
          message("early", "Early"),
          { reply: true },
          {
            notify: "item/completed",
            params: {
              threadId: "$thread",
              turnId: "turn-0",
              item: { type: "agentMessage", id: "old", text: "Old" },
            },
          },
          {
            notify: "item/completed",
            params: {
              threadId: "subagent",
              turnId: "$turn",
              item: { type: "agentMessage", id: "sub", text: "Sub" },
            },
          },
          message("late", "Late"),
          { complete: "completed" },
        ],
      ],
    });
    const { codex } = runtime(fake);
    stopAfter(codex);
    const items = await collect(codex.startTurn(turnRequest()).items);
    expect(
      items.filter((item) => item.kind === "message.completed").map((item) => item.itemId),
    ).toEqual(["early", "late"]);
  });

  it("hands a thread's turns another agent ran to Codex", async () => {
    const fake = fakeCodex({});
    const { codex, records } = runtime(fake);
    stopAfter(codex);
    records.set("thread-1", "codex-thread-9");
    const history = [
      {
        type: "agent.turn.started",
        payload: { turnId: "a", agentId: CODEX_AGENT_ID, input: { text: "to codex" } },
      },
      {
        type: "agent.item.completed",
        payload: { turnId: "a", kind: "message", text: "from codex" },
      },
      {
        type: "agent.turn.started",
        payload: { turnId: "b", agentId: "jhin.agent-fake", input: { text: "to fake" } },
      },
      {
        type: "agent.item.completed",
        payload: { turnId: "b", kind: "message", text: "from fake" },
      },
    ].map((event, index) => ({ ...event, stream: "thread/thread-1", sequence: index + 1, at: "" }));
    await collect(
      codex.startTurn(turnRequest({ history: history as TurnRequest["history"] })).items,
    );
    const text = turnText(fake, 0);
    expect(text).toContain("Since your last turn this thread went on with another agent.");
    expect(text).toContain("User: to fake\nAssistant: from fake");
    expect(text).not.toContain("to codex");
  });

  it("hands the earlier turns over again when the turn that started the Codex thread failed", async () => {
    const fake = fakeCodex({ errors: { "turn/start": [{ message: "bad input" }] } });
    const { codex, records } = runtime(fake);
    stopAfter(codex);
    const history = [
      {
        type: "agent.turn.started",
        payload: { turnId: "b", agentId: "jhin.agent-fake", input: { text: "to fake" } },
      },
      {
        type: "agent.item.completed",
        payload: { turnId: "b", kind: "message", text: "from fake" },
      },
    ].map((event, index) => ({ ...event, stream: "thread/thread-1", sequence: index + 1, at: "" }));
    await expect(
      collect(codex.startTurn(turnRequest({ history: history as TurnRequest["history"] })).items),
    ).rejects.toThrow("bad input");
    // No message reached the Codex thread: nothing is recorded yet.
    expect(records.get("thread-1")).toBeUndefined();
    await collect(
      codex.startTurn(turnRequest({ history: history as TurnRequest["history"] })).items,
    );
    expect(turnText(fake, 1)).toContain("This thread started before you joined it.");
    expect(turnText(fake, 1)).toContain("User: to fake\nAssistant: from fake");
    // The failed turn ended its app-server; the next one started a Codex thread of its own.
    expect(records.get("thread-1")).toBe("codex-thread-2");
  });

  it("hands no transcript twice when the Codex thread could not be recorded", async () => {
    const fake = fakeCodex({});
    const threads: ThreadStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error("storage is down");
      },
      delete: async () => {},
    };
    const codex = createCodexRuntime({ threads, config: () => Config.parse(fake.config) });
    stopAfter(codex);
    const history = [
      {
        type: "agent.turn.started",
        payload: { turnId: "b", agentId: "jhin.agent-fake", input: { text: "to fake" } },
      },
      {
        type: "agent.item.completed",
        payload: { turnId: "b", kind: "message", text: "from fake" },
      },
    ].map((event, index) => ({ ...event, stream: "thread/thread-1", sequence: index + 1, at: "" }));
    await collect(
      codex.startTurn(turnRequest({ history: history as TurnRequest["history"] })).items,
    );
    const later = [
      ...history,
      {
        type: "agent.turn.started",
        payload: { turnId: "a", agentId: CODEX_AGENT_ID, input: { text: "hello" } },
      },
    ].map((event, index) => ({ ...event, stream: "thread/thread-1", sequence: index + 1, at: "" }));
    await collect(
      codex.startTurn(
        turnRequest({
          turnId: "turn-b",
          input: { text: "two" },
          history: later as TurnRequest["history"],
        }),
      ).items,
    );
    expect(turnText(fake, 0)).toContain("This thread started before you joined it.");
    expect(turnText(fake, 1)).toBe("two");
  });

  it("steers a message into the running turn, also one sent before Codex named it", async () => {
    const fake = fakeCodex({
      turns: [
        [
          { reply: true },
          // The early message goes in once Codex named the turn.
          { waitFor: "turn/steer" },
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "On it" },
          },
          { waitFor: "turn/steer", count: 2 },
          { complete: "completed" },
        ],
      ],
    });
    const { codex } = runtime(fake);
    stopAfter(codex);
    expect(codex.steering).toBe(true);
    const turn = codex.startTurn(turnRequest({ instructions: "You review code." }));
    // Sent before turn/start answers: it waits for Codex's turn id.
    turn.steer!({ text: "early" });
    const items = turn.items[Symbol.asyncIterator]();
    expect((await items.next()).value).toMatchObject({ kind: "message.delta" });
    turn.steer!({ text: "also this" });
    expect((await items.next()).done).toBe(true);
    expect(fake.received("turn/steer").map((call) => call.params)).toEqual([
      {
        threadId: "codex-thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "early" }],
      },
      {
        threadId: "codex-thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "also this" }],
      },
    ]);
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      collaborationMode: { settings: { developer_instructions: "You review code." } },
    });
    expect(() => turn.steer!({ text: "late" })).toThrow("The turn has ended");
  });

  it("sends images as data URLs", async () => {
    const fake = fakeCodex({});
    const { codex } = runtime(fake);
    stopAfter(codex);
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    await collect(
      codex.startTurn(
        turnRequest({
          input: {
            text: "look",
            attachments: [{ kind: "image", name: "a.png", mimeType: "image/png", dataUrl }],
          },
        }),
      ).items,
    );
    expect(fake.received("turn/start")[0]?.params?.["input"]).toEqual([
      { type: "text", text: "look" },
      { type: "image", url: dataUrl },
    ]);
  });

  it("lets a later turn take the app-server over from a turn given up on", async () => {
    const fake = fakeCodex({
      turns: [
        [
          {
            notify: "item/agentMessage/delta",
            params: { threadId: "$thread", turnId: "$turn", itemId: "m1", delta: "Working" },
          },
          { hang: true },
        ],
        [{ complete: "completed" }],
      ],
    });
    const { codex } = runtime(fake);
    stopAfter(codex);
    const first = codex.startTurn(turnRequest()).items[Symbol.asyncIterator]();
    expect((await first.next()).value).toMatchObject({ kind: "message.delta" });
    const second = await collect(codex.startTurn(turnRequest({ turnId: "turn-b" })).items);
    await expect(first.next()).rejects.toThrow("A later turn of this thread took its Codex over.");
    expect(second).toEqual([]);
    expect(fake.processes()).toHaveLength(2);
    expect(fake.received("thread/resume")).toHaveLength(1);
  });

  it("never starts Codex for a turn stopped before it began", async () => {
    const fake = fakeCodex({});
    const { codex } = runtime(fake);
    stopAfter(codex);
    const turn = codex.startTurn(turnRequest());
    turn.interrupt();
    expect(await collect(turn.items)).toEqual([]);
    expect(fake.processes()).toEqual([]);
  });
});

const runtimes: { dispose(): void }[] = [];
const stopAfter = (codex: { dispose(): void }) => runtimes.push(codex);
afterEach(() => {
  for (const codex of runtimes.splice(0)) codex.dispose();
});

describe("jhin.agent-codex: a Codex that stops answering", () => {
  it("ends a stopped turn whose turn/start Codex never answers, and its app-server", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let sent!: () => void;
    const turnStartSent = new Promise<void>((resolve) => (sent = resolve));
    let closed = 0;
    // An app-server in memory that answers everything but turn/start.
    const launch: Launcher = () => {
      let exit!: (value: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => (exit = resolve),
      );
      return {
        request: async (method) => {
          if (method === "thread/start") return { thread: { id: "codex-thread-1" } };
          if (method === "turn/start") {
            sent();
            return new Promise(() => {});
          }
          return {};
        },
        notify: () => {},
        onNotification: () => {},
        onRequest: () => {},
        exited,
        running: true,
        stderr: () => "",
        close: () => {
          closed++;
          exit({ code: null, signal: "SIGTERM" });
        },
      };
    };
    const threads: ThreadStore = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    };
    // A model is named, so no status probe runs on this launcher.
    const codex = createCodexRuntime({
      threads,
      launch,
      config: () => Config.parse({ defaultModel: "gpt-6-astra" }),
    });
    stopAfter(codex);
    const turn = codex.startTurn(turnRequest());
    const items = collect(turn.items);
    await turnStartSent;
    turn.interrupt();
    vi.advanceTimersByTime(10_000);
    expect(await items).toEqual([]);
    expect(closed).toBe(1);
    expect(codex.sessions.list()).toEqual([]);
  });
});

describe("jhin.agent-codex: two leases of one thread", () => {
  it("tells a turn whose app-server a later turn took over while it started", async () => {
    const pending: (() => void)[] = [];
    const launch: Launcher = () => {
      let rejectAll!: () => void;
      const ended = new Promise<never>(
        (_, reject) => (rejectAll = () => reject(new Error("Codex was ended."))),
      );
      ended.catch(() => {});
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      pending.push(answer);
      return {
        request: (method) =>
          method === "initialize" ? Promise.race([answered.then(() => ({})), ended]) : ended,
        notify: () => {},
        onNotification: () => {},
        onRequest: () => {},
        exited: new Promise(() => {}),
        running: true,
        stderr: () => "",
        close: () => rejectAll(),
      };
    };
    const sessions = createSessions({ launch, idleMs: () => 0 });
    const options = { binaryPath: "codex", args: [], cwd: "/work", env: {}, version: "0" };
    const first = sessions.lease("thread-1", options);
    const second = sessions.lease("thread-1", options);
    pending[1]!();
    await expect(first).rejects.toThrow("A later turn of this thread took its Codex over.");
    expect((await second).started).toBe(true);
    sessions.dispose();
  });
});

const connections: { close(): void }[] = [];
const stopConnection = (connection: { close(): void }) => connections.push(connection);
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});
