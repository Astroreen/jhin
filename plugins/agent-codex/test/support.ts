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

import { codexPlugin } from "../src/index.ts";
import type { Scenario } from "./fake-app-server.ts";

export type { Scenario, Step } from "./fake-app-server.ts";

const FAKE = new URL("./fake-app-server.ts", import.meta.url).pathname;

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

/** A fake `codex` on disk: an executable that runs the fake app-server with a scenario. */
export function fakeCodex(scenario: Scenario) {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-codex-"));
  const scenarioPath = Path.join(dir, "scenario.json");
  const logPath = Path.join(dir, "log.jsonl");
  Fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
  const binaryPath = Path.join(dir, "codex");
  Fs.writeFileSync(binaryPath, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  Fs.chmodSync(binaryPath, 0o755);
  return {
    dir,
    binaryPath,
    /** The config section running this fake. */
    config: {
      binaryPath,
      env: { FAKE_CODEX_SCENARIO: scenarioPath, FAKE_CODEX_LOG: logPath },
    },
    /** Everything the fake processes logged so far, oldest first. */
    log(): Record<string, unknown>[] {
      if (!Fs.existsSync(logPath)) return [];
      return Fs.readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    /** The requests and notifications Jhin sent, by method, oldest first. */
    received(method: string): { id?: number; params?: Record<string, unknown> }[] {
      return this.log()
        .map((entry) => entry["in"] as { method?: string } | undefined)
        .filter((message) => message?.method === method) as {
        id?: number;
        params?: Record<string, unknown>;
      }[];
    },
    /** Jhin's answers to the fake's own requests, oldest first. */
    answers(): unknown[] {
      return this.log()
        .filter((entry) => entry["answer"] !== undefined)
        .map(
          (entry) =>
            (entry["answer"] as { result?: unknown; error?: unknown }).result ??
            (entry["answer"] as { error?: unknown }).error,
        );
    },
    /** App-servers that ran a Codex thread (status probes start none), oldest first. */
    processes(): number[] {
      const pids = this.log()
        .filter((entry) => {
          const method = (entry["in"] as { method?: unknown } | undefined)?.method;
          return method === "thread/start" || method === "thread/resume";
        })
        .map((entry) => entry["pid"] as number);
      return [...new Set(pids)];
    },
  };
}
export type FakeCodex = ReturnType<typeof fakeCodex>;

const stops: (() => Promise<void>)[] = [];
export async function stopAll() {
  for (const stop of stops.splice(0)) await stop();
}

/** A node with the threads plugin and Codex on the fake, its default agent. */
export async function node(fake: FakeCodex, config: Record<string, unknown> = {}) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-codex-node-"));
  const storage = memoryStoragePlugin();
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
      { manifest: manifest("agent-codex"), definition: codexPlugin() },
    ],
  });
  kernel.config.setLayer("node", { "jhin.agent-codex": { ...fake.config, ...config } });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  stops.push(async () => {
    client.close();
    await kernel.stop();
  });
  return { client, storage, kernel };
}
export type Client = Awaited<ReturnType<typeof node>>["client"];

/** Resolves with the thread's events once `count` of type `type` are recorded. */
export function until(
  client: Client,
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

export const payloads = (events: readonly StoredEvent[], type: string) =>
  events
    .filter((event) => event.type === type)
    .map((event) => event.payload as Record<string, unknown>);
