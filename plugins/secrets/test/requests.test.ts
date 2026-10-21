import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { ThreadEvents, threadStream } from "@jhin/agent-api";
import { AGENT_PERMISSIONS } from "@jhin/mcp-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, type Logger } from "@jhin/sdk";
import {
  SECRETS_STORE_CAPABILITY,
  SecretsThreadEvents,
  type SecretRequestResult,
  type SecretStore,
} from "@jhin/secrets-api";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  createMemoryStorage,
  type MemoryStorage,
  type StoredEvent,
} from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  mockCapability,
  testManifest,
  type TestKernel,
} from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import agent from "@jhin/plugin-agent-fake";
import threads from "@jhin/plugin-threads";
import secrets from "../src/index.ts";

// A recognisable value, looked for everywhere it must not be (security.md D1033).
const SECRET = "whsec-7d1f0a99-NEVER-LEAK";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.useRealTimers();
});

interface Node {
  readonly kernel: TestKernel;
  readonly client: RpcClient;
  readonly storage: MemoryStorage;
  readonly store: SecretStore;
  /** Every log line and kernel event of the node, as text. */
  readonly logs: string[];
  readonly events: string[];
  /** Resolves with the first event of the thread (seen or to come) that `match` accepts. */
  until(threadId: string, match: (event: StoredEvent) => boolean): Promise<StoredEvent>;
  stop(): Promise<void>;
}

async function node(storage = createMemoryStorage()): Promise<Node> {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-secrets-"));
  const logs: string[] = [];
  const logger: Logger = {
    debug: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    info: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    warn: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    error: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    child: () => logger,
  };
  let store!: SecretStore;
  // A plugin that requires `secrets.store@1`, as a consumer does.
  const consumer = {
    manifest: testManifest("test.consumer", { requires: { [SECRETS_STORE_CAPABILITY]: "^1" } }),
    definition: definePlugin({
      activate(context) {
        store = context.services.get<SecretStore>(SECRETS_STORE_CAPABILITY);
      },
    }),
  };
  const kernel = await createTestKernel({
    logger,
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => Path.join(data, id),
      }),
      mockCapability("host.identity", { nodeId: "node-1" }),
      {
        manifest: testManifest("mock.storage", {
          provides: { [KV_CAPABILITY]: "1.0.0", [EVENTLOG_CAPABILITY]: "1.2.0" },
        }),
        definition: definePlugin({
          activate(context) {
            context.services.provide(KV_CAPABILITY, storage.kv);
            context.services.provide(EVENTLOG_CAPABILITY, storage.log);
          },
        }),
      },
      { manifest: manifest("threads"), definition: threads },
      { manifest: manifest("agent-fake"), definition: agent },
      { manifest: manifest("secrets"), definition: secrets },
      consumer,
    ],
    // The machine's own keychain stays out of tests.
    config: { node: { "jhin.secrets": { keychain: "off" } } },
  });
  const inactive = kernel.inspect().plugins.filter((plugin) => plugin.status !== "active");
  if (inactive.length > 0) throw new Error(`Plugins not active: ${JSON.stringify(inactive)}`);
  const events: string[] = [];
  const all = kernel.events.onAny((event) => events.push(JSON.stringify(event)));
  const { client } = connectInMemory(kernel, { log: storage.log });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    all.dispose();
    client.close();
    await kernel.stop();
  };
  cleanups.push(stop);
  const until = async (threadId: string, match: (event: StoredEvent) => boolean) => {
    const stream = threadStream(threadId);
    return new Promise<StoredEvent>((resolve) => {
      let done = false;
      const subscription = storage.log.subscribe(stream, (event) => {
        if (!done && match(event)) {
          done = true;
          subscription.dispose();
          resolve(event);
        }
      });
      void storage.log.read(stream).then((earlier) => {
        const found = earlier.find(match);
        if (found !== undefined && !done) {
          done = true;
          subscription.dispose();
          resolve(found);
        }
      });
    });
  };
  return { kernel, client, storage, store, logs, events, until, stop };
}

async function runningThread(target: Node): Promise<{ id: string; projectId: string }> {
  const thread = await target.client.call<{ id: string; projectId: string }>("threads.create", {});
  const started = target.until(thread.id, (event) => event.type === ThreadEvents.turnStarted);
  await target.client.call("threads.send", { threadId: thread.id, text: "/hold" });
  await started;
  return thread;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected the call to fail");
}

describe("secret requests (security.md D1028–D1031)", () => {
  it("keeps the answer out of the thread, the logs, the events and every response", async () => {
    const target = await node();
    const thread = await runningThread(target);
    const opened = target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestOpened,
    );
    const asked = target.client.call<SecretRequestResult>("secrets.request", {
      threadId: thread.id,
      label: "GitHub webhook secret",
      reason: "Signs the requests GitHub sends to the task's webhook.",
      placeholder: "Paste the secret",
    });
    const card = await opened;
    const requestId = (card.payload as { requestId: string }).requestId;
    expect(card.payload).toMatchObject({
      label: "GitHub webhook secret",
      reason: "Signs the requests GitHub sends to the task's webhook.",
      placeholder: "Paste the secret",
      turnId: expect.any(String),
    });

    const answered = await target.client.call("secrets.requests.answer", {
      threadId: thread.id,
      requestId,
      answer: { type: "save", secret: `  ${SECRET} ` },
    });
    expect(answered).toEqual({ status: "saved" });
    const result = await asked;
    expect(result).toEqual({ status: "saved", secretRef: expect.stringMatching(/^secret-ref:/) });
    const closed = await target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestClosed,
    );
    expect(closed.payload).toEqual({ requestId, status: "saved" });

    // A second answer is told the request is answered.
    const again = await rejection(
      target.client.call("secrets.requests.answer", {
        threadId: thread.id,
        requestId,
        answer: { type: "decline" },
      }),
    );
    expect(again).toMatchObject({ code: "SECRET_REQUEST_ANSWERED" });

    // Only the node's own code gets the value, once, for the thread's project (D1031).
    const ref = (result as { secretRef: string }).secretRef;
    expect(target.store.consumeRef({ ref, projectId: thread.projectId })).toBe(SECRET);
    expect(() => target.store.consumeRef({ ref, projectId: thread.projectId })).toThrow(
      "already used",
    );

    const transcript = JSON.stringify(await target.storage.log.read(threadStream(thread.id)));
    expect(transcript).toContain(SecretsThreadEvents.requestClosed);
    expect(transcript).not.toContain(SECRET);
    expect(
      JSON.stringify([answered, result, await target.client.call("secrets.status", {})]),
    ).not.toContain(SECRET);
    expect(target.events.join("\n")).not.toContain(SECRET);
    expect(target.logs.join("\n")).not.toContain(SECRET);
    for (const stream of await target.storage.log.streams()) {
      expect(JSON.stringify(await target.storage.log.read(stream.stream))).not.toContain(SECRET);
    }
  });

  it("declines, and refuses an answer from an agent", async () => {
    const target = await node();
    const thread = await runningThread(target);
    const opened = target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestOpened,
    );
    const asked = target.client.call<SecretRequestResult>("secrets.request", {
      threadId: thread.id,
      label: "Token",
      reason: "For the API.",
    });
    const { requestId } = (await opened).payload as { requestId: string };
    const agentAnswer = await rejection(
      target.kernel.commands.execute(
        "secrets.requests.answer",
        { threadId: thread.id, requestId, answer: { type: "save", secret: SECRET } },
        { caller: { id: "jhin.agent-claude:thread", permissions: AGENT_PERMISSIONS } },
      ),
    );
    expect(agentAnswer.code).toBe("PERMISSION_DENIED");
    await target.client.call("secrets.requests.answer", {
      threadId: thread.id,
      requestId,
      answer: { type: "decline" },
    });
    expect(await asked).toEqual({ status: "declined" });
  });

  it("is a tool a thread's agent may call, in its own thread only", async () => {
    const target = await node();
    const thread = await runningThread(target);
    const other = await runningThread(target);
    const agent = {
      caller: { id: `jhin.agent-claude:${thread.id}`, permissions: AGENT_PERMISSIONS },
      threadId: thread.id,
    };
    const elsewhere = await rejection(
      target.kernel.commands.execute(
        "secrets.request",
        { threadId: other.id, label: "Token", reason: "For the API." },
        agent,
      ),
    );
    expect(elsewhere).toMatchObject({ code: "SECRET_REQUEST_OTHER_THREAD" });
    const opened = target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestOpened,
    );
    const asked = target.kernel.commands.execute(
      "secrets.request",
      { label: "Token", reason: "For the API." },
      agent,
    );
    const { requestId } = (await opened).payload as { requestId: string };
    await target.client.call("secrets.requests.answer", {
      threadId: thread.id,
      requestId,
      answer: { type: "decline" },
    });
    expect(await asked).toEqual({ status: "declined" });
  });

  it("ends with the turn, and needs a running one", async () => {
    const target = await node();
    const idle = await target.client.call<{ id: string }>("threads.create", {});
    const refused = await rejection(
      target.client.call("secrets.request", { threadId: idle.id, label: "A", reason: "B" }),
    );
    expect(refused).toMatchObject({ code: "SECRET_REQUEST_NO_TURN" });

    const thread = await runningThread(target);
    const opened = target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestOpened,
    );
    const asked = target.client.call<SecretRequestResult>("secrets.request", {
      threadId: thread.id,
      label: "Token",
      reason: "For the API.",
    });
    const { requestId } = (await opened).payload as { requestId: string };
    await target.client.call("threads.interrupt", { threadId: thread.id });
    expect(await asked).toEqual({ status: "cancelled" });
    const closed = await target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestClosed,
    );
    expect(closed.payload).toEqual({ requestId, status: "cancelled" });
    const late = await rejection(
      target.client.call("secrets.requests.answer", {
        threadId: thread.id,
        requestId,
        answer: { type: "save", secret: SECRET },
      }),
    );
    expect(late).toMatchObject({
      code: "SECRET_REQUEST_ANSWERED",
      message: "This secret request was already answered.",
    });
  });

  it("times out, and joins a request asked again with its clientRequestId", async () => {
    const target = await node();
    const thread = await runningThread(target);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opened = target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestOpened,
    );
    const input = {
      threadId: thread.id,
      label: "Token",
      reason: "For the API.",
      timeoutMs: 5_000,
      clientRequestId: "ask-1",
    };
    // Both at once, before either card is open: one card.
    const first = target.client.call<SecretRequestResult>("secrets.request", input);
    const second = target.client.call<SecretRequestResult>("secrets.request", input);
    const { requestId } = (await opened).payload as { requestId: string };
    const closed = target.until(
      thread.id,
      (event) => event.type === SecretsThreadEvents.requestClosed,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toEqual({ status: "timed_out" });
    expect(await second).toEqual({ status: "timed_out" });
    expect((await closed).payload).toEqual({ requestId, status: "cancelled" });
    const cards = (await target.storage.log.read(threadStream(thread.id))).filter(
      (event) => event.type === SecretsThreadEvents.requestOpened,
    );
    expect(cards).toHaveLength(1);
    // Asked again after it ended, the same id gives the same answer.
    expect(await target.client.call("secrets.request", input)).toEqual({ status: "timed_out" });
  });

  it("closes the cards a stopped node left open", async () => {
    const storage = createMemoryStorage();
    await storage.kv.set("jhin.secrets", "pending/left-open", { threadId: "t-1" });
    const target = await node(storage);
    const closed = await target.until(
      "t-1",
      (event) => event.type === SecretsThreadEvents.requestClosed,
    );
    expect(closed.payload).toEqual({ requestId: "left-open", status: "cancelled" });
    expect(await storage.kv.get("jhin.secrets", "pending/left-open")).toBeUndefined();
  });
});
