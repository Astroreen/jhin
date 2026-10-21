import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  AGENT_REGISTRY_CAPABILITY,
  type AgentItem,
  type AgentRegistry,
  type TurnRequest,
} from "@jhin/agent-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, z } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  testManifest,
  type TestKernel,
  type TestPlugin,
} from "@jhin/testing";
import { afterEach } from "vite-plus/test";

import fake from "@jhin/plugin-agent-fake";
import threads from "@jhin/plugin-threads";
import agents from "../src/index.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

export const NODE_ID = "node-a";
/** A runtime whose id is also a valid agent id, to test that ids are not shared. */
export const CAPTURE = "capture";

/**
 * A runtime that records every turn request it gets and answers "ok", so a
 * test can read what a defined agent handed its runtime.
 */
function captureRuntime(requests: TurnRequest[]): TestPlugin {
  return {
    manifest: testManifest("test.capture", {
      side: "server",
      requires: { [AGENT_REGISTRY_CAPABILITY]: "^1" },
    }),
    definition: definePlugin({
      activate(context) {
        const registry = context.services.get<AgentRegistry>(AGENT_REGISTRY_CAPABILITY);
        context.subscriptions.add(
          registry.register({
            agentId: CAPTURE,
            name: "Capture",
            models: [{ id: "m1", name: "M1" }],
            startTurn(request) {
              requests.push(request);
              return {
                items: (async function* (): AsyncGenerator<AgentItem> {
                  yield { kind: "message.completed", itemId: `${request.turnId}:1`, text: "ok" };
                })(),
                interrupt() {},
              };
            },
          }),
        );
      },
    }),
  };
}

/**
 * The host's `host.config.get` and `host.config.patch` over the test kernel's
 * layers, as a node host writes its files (enough for one section's keys).
 */
/** Makes the next `host.config.patch` of a layer fail, as a write the host refused. */
interface Patches {
  failNext: "node" | "project" | undefined;
}

function hostConfig(
  kernel: () => TestKernel,
  layers: Record<string, Record<string, unknown>>,
  patches: Patches,
) {
  return {
    manifest: testManifest("test.host-config", { side: "server" }),
    definition: definePlugin({
      activate(context) {
        context.commands.register({
          name: "host.config.get",
          description: "test",
          input: z.object({ section: z.string() }),
          output: z.unknown(),
          handler: ({ section }) => ({
            layers: { node: layers["node"]?.[section], project: layers["project"]?.[section] },
          }),
        });
        context.commands.register({
          name: "host.config.patch",
          description: "test",
          input: z.object({
            layer: z.enum(["node", "project"]),
            section: z.string(),
            values: z.record(z.string(), z.unknown()),
          }),
          output: z.unknown(),
          handler: ({ layer, section, values }) => {
            if (patches.failNext === layer) {
              patches.failNext = undefined;
              throw new Error(`the ${layer} file cannot be written`);
            }
            const current = layers[layer] ?? {};
            layers[layer] = {
              ...current,
              [section]: { ...(current[section] as object | undefined), ...values },
            };
            kernel().config.setLayer(layer, layers[layer]!);
            return { applied: true, at: Date.now() };
          },
        });
      },
    }),
  };
}

/** What a node leaves behind for the next start on its data. */
interface Restart {
  readonly data: string;
  readonly storage: ReturnType<typeof memoryStoragePlugin>;
  readonly layers: Record<string, Record<string, unknown>>;
}

export async function node(
  options: {
    agents?: Record<string, unknown>;
    /** The pinned default agent; `null` leaves the node to pick one. */
    defaultAgent?: string | null;
    /** To start a node again on the data, storage and config files of a stopped one. */
    restart?: Restart;
    /** What the project file says, as `{ section: value }`. */
    project?: Record<string, unknown>;
  } = {},
) {
  const data = options.restart?.data ?? Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-agents-"));
  const storage = options.restart?.storage ?? memoryStoragePlugin();
  const requests: TurnRequest[] = [];
  const layers: Record<string, Record<string, unknown>> = options.restart?.layers ?? {
    ...(options.project === undefined ? {} : { project: options.project }),
    node: {
      ...(options.defaultAgent === null
        ? {}
        : { "jhin.threads": { defaultAgent: options.defaultAgent ?? "jhin.agent-fake" } }),
      ...(options.agents === undefined ? {} : { "jhin.agents": { agents: options.agents } }),
    },
  };
  let kernel: TestKernel | undefined;
  const patches: Patches = { failNext: undefined };
  const plugins: TestPlugin[] = [
    mockCapability("host.paths", {
      home: data,
      dataDir: (id: string) => {
        Fs.mkdirSync(Path.join(data, id), { recursive: true });
        return Path.join(data, id);
      },
    }),
    mockCapability("host.identity", { nodeId: NODE_ID }),
    storage,
    { manifest: manifest("threads"), definition: threads },
    { manifest: manifest("agent-fake"), definition: fake },
    captureRuntime(requests),
    hostConfig(() => kernel!, layers, patches),
    { manifest: manifest("agents"), definition: agents },
  ];
  kernel = await createTestKernel({ plugins, config: layers });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    client.close();
    await kernel!.stop();
  };
  stops.push(stop);
  return { kernel, client, data, requests, layers, storage, hostConfig: patches, stop };
}

/** Follows a stream; `until(type)` resolves with the first event of that type, seen or future. */
export function watch(client: RpcClient, stream: string) {
  const events: StoredEvent[] = [];
  const waiters: { test: (event: StoredEvent) => boolean; resolve: (e: StoredEvent) => void }[] =
    [];
  client.subscribe(stream, {}, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.test(event))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  const untilMatch = (test: (event: StoredEvent) => boolean) => {
    const seen = events.find(test);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<StoredEvent>((resolve) => waiters.push({ test, resolve }));
  };
  /** The `skip`-th next event of a type (0: the first), seen or future. */
  const until = (type: string, skip = 0) => {
    let seen = 0;
    return untilMatch((event) => event.type === type && seen++ === skip);
  };
  return { events, until, untilMatch };
}
