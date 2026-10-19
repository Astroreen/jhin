import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  type TestPlugin,
} from "@jhin/testing";
import { afterEach } from "vite-plus/test";

import agent from "../../agent-fake/src/index.ts";
import threads from "../src/index.ts";

export const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

export const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

export async function node(
  options: {
    agent?: boolean;
    runtime?: unknown;
    /** More plugins, e.g. agent runtimes registering through agent.registry@1. */
    plugins?: readonly TestPlugin[];
    /** Storage to start over, e.g. to restart a node on its data. */
    storage?: ReturnType<typeof memoryStoragePlugin>;
    data?: string;
    config?: Record<string, unknown>;
  } = {},
) {
  const data = options.data ?? Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-threads-"));
  const storage = options.storage ?? memoryStoragePlugin();
  const plugins: TestPlugin[] = [
    mockCapability("host.paths", {
      home: data,
      dataDir: (id: string) => {
        Fs.mkdirSync(Path.join(data, id), { recursive: true });
        return Path.join(data, id);
      },
    }),
    storage,
    { manifest: manifest("threads"), definition: threads },
  ];
  if (options.runtime !== undefined) plugins.push(mockCapability("agent.runtime", options.runtime));
  else if (options.agent !== false)
    plugins.push({ manifest: manifest("agent-fake"), definition: agent });
  plugins.push(...(options.plugins ?? []));
  const kernel = await createTestKernel({
    plugins,
    ...(options.config === undefined ? {} : { config: { node: options.config } }),
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    client.close();
    await kernel.stop();
  };
  stops.push(stop);
  return { kernel, client, data, storage, stop };
}

/**
 * Subscribes to a thread (or to any stream given as `stream:<name>`); `until(type)`
 * resolves with the first event of that type (seen or future).
 */
export function watch(client: RpcClient, threadId: string) {
  const events: StoredEvent[] = [];
  const waiters: { type: string; resolve: (event: StoredEvent) => void }[] = [];
  const matchers: {
    test: (event: StoredEvent) => boolean;
    resolve: (event: StoredEvent) => void;
  }[] = [];
  const stream = threadId.startsWith("stream:") ? threadId.slice(7) : `thread/${threadId}`;
  client.subscribe(stream, {}, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.type === event.type)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
    for (const matcher of matchers.filter((item) => item.test(event))) {
      matchers.splice(matchers.indexOf(matcher), 1);
      matcher.resolve(event);
    }
  });
  const until = (type: string, skip = 0) => {
    const seen = events.filter((event) => event.type === type)[skip];
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<StoredEvent>((resolve) => waiters.push({ type, resolve }));
  };
  /** The first event (seen or future) that `test` accepts. */
  const untilMatch = (test: (event: StoredEvent) => boolean) => {
    const seen = events.find(test);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<StoredEvent>((resolve) => matchers.push({ test, resolve }));
  };
  return { events, until, untilMatch };
}
