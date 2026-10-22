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

import { OPENCODE_AGENT_ID, openCodePlugin } from "../src/index.ts";
import { answer, fakeOpenCode, type Script } from "./fake-server.ts";
import { PASSWORD } from "./support.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function node(...scripts: Script[]) {
  const fake = await fakeOpenCode({ password: PASSWORD, scripts });
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-opencode-"));
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
      { manifest: manifest("agent-opencode"), definition: openCodePlugin() },
    ],
  });
  kernel.config.setLayer("node", {
    "jhin.agent-opencode": { enabled: true, serverUrl: fake.url, serverPassword: PASSWORD },
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  stops.push(async () => {
    client.close();
    await kernel.stop();
    await fake.close();
  });
  return { client, fake, storage };
}

/** Resolves with the thread's events once `count` of type `type` are recorded. */
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

describe("jhin.agent-opencode: the plugin", () => {
  it("registers OpenCode as an agent of the node, with its models", async () => {
    const { client } = await node();
    const agents = await client.call<
      { agentId: string; name: string; available: boolean; models: { id: string }[] }[]
    >("agents.list", {});
    const opencode = agents.find((agent) => agent.agentId === OPENCODE_AGENT_ID);
    expect(opencode).toMatchObject({
      name: "OpenCode",
      available: true,
      models: [{ id: "anthropic/claude-sonnet-5-5" }, { id: "openai/gpt-6" }],
    });
  });

  it("runs a thread's turns on one OpenCode session and forgets it with the thread", async () => {
    const { client, fake, storage } = await node(answer("It is Jhin."), answer("Again."));
    const thread = await client.call<{ id: string }>("threads.create", {
      agentId: OPENCODE_AGENT_ID,
      model: "anthropic/claude-sonnet-5-5",
    });

    const first = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "What is this?" });
    const events = await first;
    expect(events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "agent.turn.started",
      "agent.item.delta",
      "agent.item.delta",
      "agent.item.completed",
      "agent.usage.updated",
      "agent.turn.completed",
    ]);
    expect(events.find((event) => event.type === "agent.item.completed")?.payload).toMatchObject({
      kind: "message",
      text: "It is Jhin.",
    });

    const second = until(client, thread.id, "agent.turn.completed", 2);
    await client.call("threads.send", { threadId: thread.id, text: "Again?" });
    await second;
    expect(fake.calls("POST", "/api/session")).toHaveLength(1);
    expect(fake.calls("POST", "/prompt")).toHaveLength(2);
    expect(
      await storage.storage.kv.get("jhin.agent-opencode", `session/${thread.id}`),
    ).toMatchObject({
      id: "ses_1",
    });

    const forgotten = new Promise<void>((resolve) => {
      const kv = storage.storage.kv;
      const original = kv.delete.bind(kv);
      kv.delete = async (namespace, key) => {
        const removed = await original(namespace, key);
        if (namespace === "jhin.agent-opencode") resolve();
        return removed;
      };
    });
    await client.call("threads.delete", { threadId: thread.id });
    await forgotten;
    expect(
      await storage.storage.kv.get("jhin.agent-opencode", `session/${thread.id}`),
    ).toBeUndefined();
  });
});
