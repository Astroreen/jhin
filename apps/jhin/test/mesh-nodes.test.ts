import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { connectWebSocket, createRpcClient, type RpcClient } from "@jhin/rpc";
import { afterAll, describe, expect, it } from "vite-plus/test";

const BIN = Path.resolve(import.meta.dirname, "../bin/jhin.js");

interface Node {
  readonly name: string;
  readonly home: string;
  readonly http: string;
  readonly nodeId: string;
  readonly client: RpcClient;
  stop(): Promise<void>;
}

const running: Node[] = [];
afterAll(async () => {
  for (const node of running.splice(0)) await node.stop();
});

function home(name: string, mesh: Record<string, unknown>): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-mesh-${name}-`));
  Fs.mkdirSync(Path.join(dir, ".jhin"));
  Fs.writeFileSync(
    Path.join(dir, ".jhin", "config.jsonc"),
    JSON.stringify({ "jhin.http": { port: 0 }, "jhin.mesh": { name, ...mesh } }),
  );
  return dir;
}

/** `jhin serve` on a free port in `dir`; connected over RPC once it printed its endpoints. */
async function serve(name: string, dir: string): Promise<Node> {
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

interface NodeView {
  readonly nodeId: string;
  readonly reachable: boolean;
  readonly route?: readonly string[];
}

/** Re-checks `condition` on `node`'s mesh view whenever its mesh stream moves: no polling, no sleeps. */
function until(
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
    const subscription = node.client.subscribe("mesh", {}, () => void check());
    void check();
  });
}

describe("a mesh of real nodes", () => {
  // Four node processes start in this test; the limit bounds the run, nothing waits on time.
  it(
    "joins, relays a → c through b, and finds c again after it restarts",
    { timeout: 60_000 },
    async () => {
      // a and c advertise no address: neither can dial the other, both dial b.
      const homeC = home("c", { advertise: [] });
      const a = await serve("a", home("a", { advertise: [] }));
      const b = await serve("b", home("b", {}));
      let c = await serve("c", homeC);

      const invite = (node: Node) => node.client.call<{ url: string; code: string }>("mesh.invite");
      const forA = await invite(b);
      await a.client.call("mesh.join", { url: forA.url, code: forA.code });
      const forC = await invite(b);
      await c.client.call("mesh.join", { url: forC.url, code: forC.code });

      const reachC = (nodes: readonly NodeView[]) =>
        nodes.some((node) => node.nodeId === c.nodeId && node.reachable);
      const nodes = await until(a, reachC);
      expect(nodes.find((node) => node.nodeId === c.nodeId)?.route).toEqual([
        a.nodeId,
        b.nodeId,
        c.nodeId,
      ]);

      expect(
        await a.client.call("mesh.call", {
          node: c.nodeId,
          method: "example.greet",
          params: { name: "Ada" },
        }),
      ).toEqual({
        message: "Hello, Ada!",
        count: 1,
      });
      expect(
        await a.client.call("mesh.resolve", { address: `jhin://${c.nodeId}/threads/42` }),
      ).toMatchObject({
        nodeId: c.nodeId,
        path: "threads/42",
        node: { reachable: true, route: [a.nodeId, b.nodeId, c.nodeId] },
      });

      await c.stop();
      await until(a, (view) => !view.some((node) => node.nodeId === c.nodeId && node.reachable));
      await expect(
        a.client.call("mesh.call", {
          node: c.nodeId,
          method: "example.greet",
          params: { name: "x" },
        }),
      ).rejects.toMatchObject({
        code: "NODE_UNREACHABLE",
      });

      // c comes back from the same home: it remembers b and dials it.
      c = await serve("c", homeC);
      await until(a, reachC);
      expect(
        await a.client.call("mesh.call", {
          node: c.nodeId,
          method: "example.greet",
          params: { name: "Bo" },
        }),
      ).toMatchObject({
        message: "Hello, Bo!",
      });
    },
  );
});
