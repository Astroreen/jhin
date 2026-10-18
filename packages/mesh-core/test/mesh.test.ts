import * as Crypto from "node:crypto";

import { noopLogger } from "@jhin/kernel";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createMemoryNetwork, createMesh, type Mesh } from "../src/index.ts";

type Network = ReturnType<typeof createMemoryNetwork>;

interface TestNode {
  readonly id: string;
  readonly address: string;
  readonly mesh: Mesh;
}

const meshes: Mesh[] = [];
afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.dispose();
});

function startNode(network: Network, id: string, options: { advertise?: boolean } = {}): TestNode {
  const keys = Crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const address = `mem://${id}`;
  const mesh = createMesh({
    identity: { nodeId: id, publicKey, name: id },
    sign: (data) => Crypto.sign(null, Buffer.from(data), keys.privateKey).toString("base64url"),
    verify: (key, data, signature) =>
      Crypto.verify(
        null,
        Buffer.from(data),
        Crypto.createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" }),
        Buffer.from(signature, "base64url"),
      ),
    transport: network.transport(address),
    execute: async (method, params, invocation) => ({
      node: id,
      method,
      params,
      caller: invocation.caller?.id,
    }),
    logger: noopLogger,
    retryDelay: () => 1,
  });
  meshes.push(mesh);
  network.listen(address, {
    accept(peer, token) {
      const from = mesh.verifyToken(token);
      if (from === undefined) return false;
      mesh.accept(peer, from);
      return true;
    },
    join: (request) => mesh.acceptJoin(request),
  });
  if (options.advertise !== false) mesh.setUrls([address]);
  return { id, address, mesh };
}

/** Resolves once `condition` holds, re-checking whenever any of the meshes changes. */
function until(nodes: readonly TestNode[], condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const subscriptions = nodes.map((node) => node.mesh.onChange(check));
    function check() {
      if (!condition()) return;
      for (const subscription of subscriptions) subscription.dispose();
      resolve();
    }
    check();
  });
}

const view = (from: TestNode, to: TestNode) =>
  from.mesh.members().find((member) => member.record.nodeId === to.id);

async function chain(network: Network, options: { cAdvertises?: boolean } = {}) {
  const a = startNode(network, "a");
  const b = startNode(network, "b");
  const c = startNode(network, "c", { advertise: options.cAdvertises ?? true });
  await b.mesh.join(a.address, a.mesh.invite().code);
  await c.mesh.join(b.address, b.mesh.invite().code);
  const all = [a, b, c];
  await until(all, () => all.every((x) => all.every((y) => view(x, y)?.reachable === true)));
  return { a, b, c, all };
}

describe("mesh", () => {
  it("joins nodes with one-time invites and spreads membership by gossip", async () => {
    const network = createMemoryNetwork();
    const { a, c } = await chain(network);

    // a never met c: it learned about c from b.
    expect(view(a, c)?.record).toMatchObject({ nodeId: "c", urls: ["mem://c"] });
    expect(a.mesh.members().map((member) => member.record.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("refuses used, unknown and expired invites", async () => {
    const network = createMemoryNetwork();
    const a = startNode(network, "a");
    const b = startNode(network, "b");
    const { code } = a.mesh.invite();
    await b.mesh.join(a.address, code);

    const c = startNode(network, "c");
    await expect(c.mesh.join(a.address, code)).rejects.toMatchObject({ code: "INVITE_INVALID" });
    await expect(c.mesh.join(a.address, "made-up")).rejects.toMatchObject({
      code: "INVITE_INVALID",
    });
  });

  it("routes a call from a to c through b when a and c cannot reach each other", async () => {
    const network = createMemoryNetwork();
    network.block("mem://a", "mem://c");
    const { a, c } = await chain(network);

    expect(view(a, c)).toMatchObject({ linked: false, reachable: true, route: ["a", "b", "c"] });
    expect(await a.mesh.call("c", "app.whoami", { n: 1 }, "trace-1")).toEqual({
      node: "c",
      method: "app.whoami",
      params: { n: 1 },
      caller: "node:a",
    });
    expect(await c.mesh.call("a", "app.whoami", {})).toMatchObject({ node: "a", caller: "node:c" });
  });

  it("reaches a node without an address (behind NAT) over the link it opened", async () => {
    const network = createMemoryNetwork();
    const { a, c } = await chain(network, { cAdvertises: false });

    expect(view(a, c)).toMatchObject({ linked: false, reachable: true, route: ["a", "b", "c"] });
    expect(await a.mesh.call("c", "app.whoami", {})).toMatchObject({ node: "c", caller: "node:a" });
  });

  it("notices a node leaving and coming back", async () => {
    const network = createMemoryNetwork();
    network.block("mem://a", "mem://c");
    const { a, c, all } = await chain(network);

    network.down(c.address);
    await until(all, () => view(a, c)?.reachable === false);
    await expect(a.mesh.call("c", "app.whoami", {})).rejects.toMatchObject({
      code: "NODE_UNREACHABLE",
    });

    network.up(c.address);
    await until(all, () => view(a, c)?.reachable === true);
    expect(await a.mesh.call("c", "app.whoami", {})).toMatchObject({ node: "c" });
  });

  it("resolves an address to the node's new URL after it moved", async () => {
    const network = createMemoryNetwork();
    const { a, b, c, all } = await chain(network);
    expect(a.mesh.resolve("jhin://c/threads/42")).toMatchObject({
      nodeId: "c",
      path: "threads/42",
    });

    // c moves: the new address serves it, the old one is gone.
    network.listen("mem://c-moved", {
      accept(peer, token) {
        const from = c.mesh.verifyToken(token);
        if (from === undefined) return false;
        c.mesh.accept(peer, from);
        return true;
      },
      join: (request) => c.mesh.acceptJoin(request),
    });
    c.mesh.setUrls(["mem://c-moved"]);
    await until(
      all,
      () => a.mesh.resolve("jhin://c/threads/42").member?.record.urls[0] === "mem://c-moved",
    );
    // The old address goes away; whoever dialled it reconnects to the new one.
    network.unlisten("mem://c");
    await until(all, () => view(a, c)?.reachable === true && view(b, c)?.linked === true);

    expect(await a.mesh.call("c", "app.whoami", {})).toMatchObject({ node: "c" });
  });

  it("accepts link tokens only from members, for this node, before they expire", () => {
    const network = createMemoryNetwork();
    const a = startNode(network, "a");
    const stranger = startNode(network, "stranger");

    // A well-formed token from a node a never met.
    const forged = `stranger.a.${Date.now() + 60_000}.c2lnbmF0dXJl`;
    expect(a.mesh.verifyToken(forged)).toBeUndefined();
    expect(a.mesh.verifyToken("garbage")).toBeUndefined();
    expect(stranger.mesh.verifyToken(`a.stranger.${Date.now() - 1}.x`)).toBeUndefined();
  });
});
