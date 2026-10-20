import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { MESH_STREAMS_CAPABILITY } from "@jhin/mesh-api";
import { LIVE_STREAMS_CAPABILITY, type RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import {
  TERMINALS_STREAM,
  TerminalEvents,
  terminalStream,
  type TerminalSnapshot,
  type TerminalSummary,
} from "@jhin/terminal-api";
import {
  createMemoryNetwork,
  createTestKernel,
  mockCapability,
  startMeshNode,
  type MemoryMeshNode,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import terminal from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) await stop();
});

/**
 * a — b — c: a client of a, terminals on c, and no direct route between a
 * and c (D28), so every call and event goes through b.
 */
async function trio(options: { share?: boolean } = {}) {
  const network = createMemoryNetwork();
  network.block("mem://a", "mem://c");
  const nodes = ["a", "b", "c"].map((id) => startMeshNode(network, id));
  const [a, b, c] = nodes as [MemoryMeshNode, MemoryMeshNode, MemoryMeshNode];
  stops.push(() => nodes.forEach((node) => node.dispose()));
  const kernel = await createTestKernel({
    plugins: [
      mockCapability(LIVE_STREAMS_CAPABILITY, c.live, "1.1.0"),
      ...(options.share === false ? [] : [mockCapability(MESH_STREAMS_CAPABILITY, c.meshStreams)]),
      { manifest, definition: terminal },
    ],
    config: { node: { "jhin.terminal": { shell: "/bin/sh" } } },
  });
  stops.push(() => kernel.stop());
  c.use(kernel);
  await b.join(a);
  await c.join(b);
  const { client } = a.connect();
  stops.push(() => client.close());
  const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-mesh-"));
  stops.push(() => Fs.rmSync(cwd, { recursive: true, force: true }));
  const onC = <T>(method: string, params: unknown) =>
    client.call<T>("mesh.call", { node: "c", method, params });
  return { client, cwd, onC };
}

/** Subscribes to `stream`, resolving with the first event `match` accepts. */
function until(
  client: RpcClient,
  stream: string,
  after: number,
  match: (event: StoredEvent, seen: readonly StoredEvent[]) => boolean,
): Promise<StoredEvent> {
  return new Promise((resolve, reject) => {
    const seen: StoredEvent[] = [];
    const subscription = client.subscribe(stream, { after, onError: reject }, (event) => {
      seen.push(event);
      if (!match(event, seen)) return;
      subscription.dispose();
      resolve(event);
    });
  });
}

const printed = (seen: readonly StoredEvent[]) =>
  seen
    .filter((event) => event.type === TerminalEvents.output)
    .map((event) => (event.payload as { data: string }).data)
    .join("");

describe("terminals of a thread on a mesh member (D501, D504)", () => {
  it("opens a terminal two hops away and streams its output through the relays", async () => {
    const { client, cwd, onC } = await trio();
    const opened = await onC<TerminalSummary>("terminals.open", {
      threadId: "t1",
      terminalId: "term-1",
      cwd,
    });
    expect(opened.status).toBe("running");

    const snapshot = await onC<TerminalSnapshot>("terminals.get", {
      threadId: "t1",
      terminalId: "term-1",
    });
    const { stream } = await client.call<{ stream: string }>("mesh.relay", {
      node: "c",
      stream: terminalStream("t1", "term-1"),
    });
    expect(stream).toBe("relay/c/terminal/t1/term-1");
    const output = until(client, stream, snapshot.sequence, (_, seen) =>
      printed(seen).includes("jhin-42"),
    );
    await onC("terminals.write", {
      threadId: "t1",
      terminalId: "term-1",
      data: "echo jhin-$((6*7))\n",
    });
    const event = await output;
    // The owner's sequences, after the snapshot's.
    expect(event.sequence).toBeGreaterThan(snapshot.sequence);

    // The node's list of terminals comes through a relay too.
    const list = await until(client, `relay/c/${TERMINALS_STREAM}`, 0, () => true);
    expect((list.payload as { terminals: TerminalSummary[] }).terminals).toMatchObject([
      { threadId: "t1", terminalId: "term-1" },
    ]);

    const closed = until(
      client,
      stream,
      event.sequence,
      (item) => item.type === TerminalEvents.closed,
    );
    await onC("terminals.close", { threadId: "t1", terminalId: "term-1" });
    await closed;
  });

  it("refuses the relay of a node whose terminal plugin shares nothing", async () => {
    const { client } = await trio({ share: false });
    await expect(until(client, "relay/c/terminal/t1/term-1", 0, () => true)).rejects.toMatchObject({
      code: "STREAM_NOT_SHARED",
    });
  });
});
