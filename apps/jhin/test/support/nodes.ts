import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";

const BIN = Path.resolve(import.meta.dirname, "../../bin/jhin.js");

export interface Node {
  readonly name: string;
  readonly home: string;
  readonly http: string;
  readonly nodeId: string;
  readonly client: RpcClient;
  stop(): Promise<void>;
}

/** A fresh home whose project config picks a free port and sets jhin.mesh options. */
export function makeHome(
  name: string,
  mesh: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-mesh-${name}-`));
  Fs.mkdirSync(Path.join(dir, ".jhin"));
  Fs.writeFileSync(
    Path.join(dir, ".jhin", "config.jsonc"),
    JSON.stringify({ "jhin.http": { port: 0 }, "jhin.mesh": { name, ...mesh }, ...extra }),
  );
  return dir;
}

/** `jhin serve` in `dir`; connected over RPC once it printed its endpoints. */
export async function serve(name: string, dir: string, running: Node[]): Promise<Node> {
  const child = ChildProcess.spawn(process.execPath, [BIN, "serve", "--home", dir, "--cwd", dir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const rpc = await new Promise<string>((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += String(chunk);
      const match = /rpc: (ws:\/\/\S+)/.exec(text);
      if (match !== null && text.includes("logs:")) resolve(match[1]!);
    });
    child.once("exit", (code) => reject(new Error(`${name} exited with ${code}:\n${text}`)));
  });
  const token = Fs.readFileSync(Path.join(dir, "data", "jhin.auth-token", "token"), "utf8").trim();
  const client = createRpcClient({ connect: () => connectWebSocket(rpc, token) });
  const node: Node = {
    name,
    home: dir,
    http: rpc.replace(/^ws/, "http").replace(/\/rpc$/, ""),
    nodeId: Fs.readFileSync(Path.join(dir, "node-id"), "utf8").trim(),
    client,
    async stop() {
      client.close();
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
  running.push(node);
  return node;
}

/** b invites, the others join it. */
export async function joinThrough(hub: Node, others: readonly Node[]): Promise<void> {
  for (const node of others) {
    const invite = await hub.client.call<{ url: string; code: string }>("mesh.invite");
    await node.client.call("mesh.join", { url: invite.url, code: invite.code });
  }
}

export interface NodeView {
  readonly nodeId: string;
  readonly reachable: boolean;
  readonly route?: readonly string[];
}

/** Re-checks `condition` on `node`'s mesh view whenever its mesh stream moves: no polling, no sleeps. */
export function untilMesh(
  node: Node,
  condition: (nodes: readonly NodeView[]) => boolean,
): Promise<readonly NodeView[]> {
  return new Promise((resolve) => {
    let done = false;
    const check = async () => {
      if (done) return;
      const nodes = await node.client.call<NodeView[]>("mesh.nodes");
      if (!done && condition(nodes)) {
        done = true;
        subscription.dispose();
        resolve(nodes);
      }
    };
    // A check still in flight when a node stops must not surface as an unhandled rejection.
    const safely = () => void check().catch(() => undefined);
    const subscription = node.client.subscribe("mesh", {}, safely);
    safely();
  });
}

/** Resolves with the events of `stream` on `node` once `condition` holds for them. */
export function untilStream(
  node: Node,
  stream: string,
  condition: (events: readonly StoredEvent[]) => boolean,
): Promise<readonly StoredEvent[]> {
  return new Promise((resolve) => {
    const events: StoredEvent[] = [];
    const subscription = node.client.subscribe(stream, {}, (event) => {
      events.push(event);
      if (condition(events)) {
        subscription.dispose();
        resolve(events);
      }
    });
  });
}

export const reachable = (target: Node) => (nodes: readonly NodeView[]) =>
  nodes.some((node) => node.nodeId === target.nodeId && node.reachable);
