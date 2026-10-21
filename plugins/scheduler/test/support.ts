import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { LIVE_STREAMS_CAPABILITY, createLiveStreams, type RpcClient } from "@jhin/rpc";
import { SCHEDULER_STREAM, type ScheduledTask } from "@jhin/scheduler-api";
import { definePlugin, z } from "@jhin/sdk";
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
import { afterEach, vi } from "vite-plus/test";

import agent from "@jhin/plugin-agent-fake";
import http from "@jhin/plugin-http";
import threads from "@jhin/plugin-threads";
import scheduler from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.useRealTimers();
});

/** Moves Date and timers by hand from `at` (local time): nothing waits on real time. */
export function fakeClock(at: Date): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(at);
}

export interface Node {
  readonly kernel: TestKernel;
  readonly client: RpcClient;
  readonly storage: MemoryStorage;
  /** The node's `rpc.streams@1.1`, which holds the stream guards. */
  readonly streams: ReturnType<typeof createLiveStreams>;
  /** The node's HTTP URL, when started with `http`. */
  readonly url: string;
  /** Resolves with the first task event (from now on, or already seen) that `match` accepts. */
  task(match: (task: ScheduledTask) => boolean): Promise<ScheduledTask>;
  /** Resolves with the first event of `stream` (seen or to come) that `match` accepts. */
  until(stream: string, match: (event: StoredEvent) => boolean): Promise<StoredEvent>;
  stop(): Promise<void>;
}

/**
 * A node with threads, the fake agent and the scheduler over memory storage
 * (`storage` to start again on what a previous node left), and the HTTP
 * server on a free port with `http`.
 */
export async function node(
  options: {
    storage?: MemoryStorage;
    http?: boolean;
    threads?: HeldThreads;
    /** A `secrets.store@1` for the scheduler to consume secretRefs from. */
    secrets?: unknown;
  } = {},
): Promise<Node> {
  const storage = options.storage ?? createMemoryStorage();
  const streams = createLiveStreams();
  const data = Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-scheduler-")));
  const kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", {
        home: data,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(data, id), { recursive: true });
          return Path.join(data, id);
        },
      }),
      {
        manifest: testManifest("mock.storage", {
          provides: { [KV_CAPABILITY]: "1.0.0", [EVENTLOG_CAPABILITY]: "1.1.0" },
        }),
        definition: definePlugin({
          activate(context) {
            context.services.provide(KV_CAPABILITY, storage.kv);
            context.services.provide(EVENTLOG_CAPABILITY, storage.log);
          },
        }),
      },
      mockCapability(LIVE_STREAMS_CAPABILITY, streams, "1.1.0"),
      ...(options.http === true ? [{ manifest: manifest("http"), definition: http }] : []),
      ...(options.threads === undefined
        ? [
            { manifest: manifest("threads"), definition: threads },
            { manifest: manifest("agent-fake"), definition: agent },
          ]
        : [options.threads.plugin]),
      ...(options.secrets === undefined ? [] : [mockCapability("secrets.store", options.secrets)]),
      { manifest: manifest("scheduler"), definition: scheduler },
    ],
    config: { node: { "jhin.http": { port: 0 } } },
  });
  const inactive = kernel.inspect().plugins.filter((plugin) => plugin.status !== "active");
  if (inactive.length > 0) throw new Error(`Plugins not active: ${JSON.stringify(inactive)}`);
  const { client } = connectInMemory(kernel, { log: storage.log });
  const waiters = new Set<{
    stream: string;
    match(event: StoredEvent): boolean;
    resolve(event: StoredEvent): void;
  }>();
  const seen = new Map<string, StoredEvent[]>();
  const watched = new Set<string>();
  const subscriptions: { dispose(): void }[] = [];
  const watch = (stream: string) => {
    if (watched.has(stream)) return;
    watched.add(stream);
    seen.set(stream, []);
    subscriptions.push(
      storage.log.subscribe(stream, (event) => {
        seen.get(stream)?.push(event);
        for (const waiter of waiters) {
          if (waiter.stream === stream && waiter.match(event)) {
            waiters.delete(waiter);
            waiter.resolve(event);
          }
        }
      }),
    );
  };
  watch(SCHEDULER_STREAM);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const subscription of subscriptions) subscription.dispose();
    client.close();
    await kernel.stop();
    Fs.rmSync(data, { recursive: true, force: true });
  };
  cleanups.push(stop);
  const until = async (stream: string, match: (event: StoredEvent) => boolean) => {
    watch(stream);
    // What came before the subscription (while the node started), then what came since.
    const earlier = await storage.log.read(stream);
    return new Promise<StoredEvent>((resolve) => {
      const found = [...earlier, ...(seen.get(stream) ?? [])].find(match);
      if (found !== undefined) resolve(found);
      else waiters.add({ stream, match, resolve });
    });
  };
  const url =
    options.http === true
      ? ((await kernel.commands.execute("http.info", {})) as { url: string }).url
      : "";
  return {
    kernel,
    client,
    storage,
    streams,
    url,
    until,
    task: async (match) =>
      (
        await until(
          SCHEDULER_STREAM,
          (event) =>
            event.type === "scheduler.task.updated" && match(event.payload as ScheduledTask),
        )
      ).payload as ScheduledTask,
    stop,
  };
}

/**
 * Threads that hold every message queued to them until `release`: what a run
 * looks like that has gone out but not come back (the node stops, or it
 * crashes, meanwhile). Projects: only the scratch project.
 */
export interface HeldThreads {
  readonly plugin: { manifest: unknown; definition: ReturnType<typeof definePlugin> };
  /** Every `threads.queue.add`, as it came. */
  readonly queued: { threadId: string; text: string; messageId: string }[];
  /** Resolves once `count` messages were queued. */
  queuedCount(count: number): Promise<void>;
  /** Lets every held message (and every later one) through. */
  release(): void;
}

export function heldThreads(): HeldThreads {
  const queued: HeldThreads["queued"] = [];
  const waiting: (() => void)[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let created = 0;
  const counters: { count: number; resolve(): void }[] = [];
  const check = () => {
    for (const counter of counters.splice(0)) {
      if (queued.length >= counter.count) counter.resolve();
      else counters.push(counter);
    }
  };
  return {
    queued,
    queuedCount: (count) =>
      new Promise((resolve) => {
        counters.push({ count, resolve });
        check();
      }),
    release: () => {
      release();
      for (const resolve of waiting.splice(0)) resolve();
    },
    plugin: {
      manifest: testManifest("test.held-threads", {
        side: "server",
        provides: { "agent.registry": "1.0.0" },
      }),
      definition: definePlugin({
        activate(context) {
          context.services.provide("agent.registry", {});
          const any = z.any();
          const command = (name: string, handler: (input: never) => unknown) =>
            context.commands.register({
              name,
              description: name,
              input: any,
              output: any,
              handler,
            });
          command("projects.list", () => [{ id: "scratch" }]);
          command("threads.create", () => ({ id: `thread-${++created}` }));
          command("threads.get", ({ threadId }: { threadId: string }) => ({
            thread: { id: threadId, projectId: "scratch" },
          }));
          command("threads.queue.add", async (input: HeldThreads["queued"][number]) => {
            queued.push(input);
            check();
            await released;
            return { messageId: input.messageId };
          });
        },
      }),
    },
  };
}

/** The text of every turn a thread started, in order. */
export async function prompts(client: RpcClient, threadId: string): Promise<string[]> {
  const events = await client.call<StoredEvent[]>("threads.events", { threadId });
  return events
    .filter((event) => event.type === "agent.turn.started")
    .map((event) => (event.payload as { input: { text: string } }).input.text);
}
