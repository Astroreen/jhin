import * as Crypto from "node:crypto";

import { noopLogger } from "@jhin/kernel";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createCaller, createPeerPair, serveRpc } from "@jhin/rpc";
import { createMemoryStorage, type EventLog } from "@jhin/storage-api";

import { createMemoryNetwork, createMesh, type Mesh } from "../src/index.ts";

type Network = ReturnType<typeof createMemoryNetwork>;

interface TestNode {
  readonly id: string;
  readonly address: string;
  readonly mesh: Mesh;
  readonly log: EventLog;
  /** Signs like the node does, to forge tokens with odd fields in tests. */
  sign(data: string): string;
}

const meshes: Mesh[] = [];
afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.dispose();
});

function startNode(
  network: Network,
  id: string,
  options: {
    advertise?: boolean;
    log?: EventLog;
    mirrors?: { owner: string; stream: string }[];
    persistMirrors?: (mirrors: readonly { owner: string; stream: string }[]) => void;
    now?: () => number;
    callDeadlineMs?: number;
    execute?: (method: string) => Promise<unknown>;
  } = {},
): TestNode {
  const keys = Crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const address = `mem://${id}`;
  const log = options.log ?? createMemoryStorage().log;
  const mesh = createMesh({
    log,
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
    execute: async (method, params, invocation) =>
      options.execute !== undefined
        ? options.execute(method)
        : { node: id, method, params, caller: invocation.caller?.id },
    logger: noopLogger,
    retryDelay: () => 1,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.callDeadlineMs === undefined ? {} : { callDeadlineMs: options.callDeadlineMs }),
    ...(options.mirrors === undefined ? {} : { mirrors: options.mirrors }),
    ...(options.persistMirrors === undefined ? {} : { persistMirrors: options.persistMirrors }),
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
  const sign = (data: string) =>
    Crypto.sign(null, Buffer.from(data), keys.privateKey).toString("base64url");
  return { id, address, mesh, log, sign };
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

async function chain(
  network: Network,
  options: { cAdvertises?: boolean; cExecute?: (method: string) => Promise<unknown> } = {},
) {
  const a = startNode(network, "a");
  const b = startNode(network, "b");
  const c = startNode(network, "c", {
    advertise: options.cAdvertises ?? true,
    ...(options.cExecute === undefined ? {} : { execute: options.cExecute }),
  });
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

  it("keeps the code of an error the node it reached threw, through a relay", async () => {
    const network = createMemoryNetwork();
    network.block("mem://a", "mem://c");
    // What a client tells apart by its code, e.g. a thread that runs a turn.
    const busy = Object.assign(new Error("The thread is already running a turn"), {
      code: "TURN_IN_PROGRESS",
    });
    const { a } = await chain(network, { cExecute: () => Promise.reject(busy) });

    await expect(a.mesh.call("c", "threads.send", {})).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
      message: "The thread is already running a turn",
    });
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

  it("ignores malformed records arriving by gossip or join", async () => {
    const network = createMemoryNetwork();
    const { a, b, c, all } = await chain(network);
    const before = a.mesh.members().length;

    // A member sends garbage next to a valid change.
    const evil = { nodeId: "x.y", publicKey: 5, urls: "nope", neighbors: [], version: -1 };
    expect(() => a.mesh.acceptJoin({ code: a.mesh.invite().code, record: evil as never })).toThrow(
      expect.objectContaining({ code: "JOIN_INVALID" }),
    );
    b.mesh.setUrls(["mem://b", "mem://b-too"]);
    await until(all, () => view(a, b)?.record.urls.length === 2);

    expect(a.mesh.members()).toHaveLength(before);
    expect(await a.mesh.call("c", "app.whoami", {})).toMatchObject({ node: "c" });
    void c;
  });

  it("refuses properly signed link tokens whose expiry is not a near, finite time", () => {
    const network = createMemoryNetwork();
    const a = startNode(network, "a");
    const b = startNode(network, "b");
    a.mesh.acceptJoin({ code: a.mesh.invite().code, record: b.mesh.self() });
    const signed = (expires: string) => `b.a.${expires}.${b.sign(`jhin-mesh-link:b:a:${expires}`)}`;

    expect(a.mesh.verifyToken(signed(String(Date.now() + 60_000)))).toBe("b");
    expect(a.mesh.verifyToken(signed("NaN"))).toBeUndefined();
    expect(a.mesh.verifyToken(signed(String(Date.now() + 365 * 24 * 3600 * 1000)))).toBeUndefined();
    expect(a.mesh.verifyToken(signed(String(Date.now() - 1)))).toBeUndefined();
  });

  it("moves its own version past an echo of an older life, and drops records from the far future", () => {
    const network = createMemoryNetwork();
    const a = startNode(network, "a");
    const ahead = a.mesh.self().version + 10 * 60 * 1000;

    // A peer still remembers a's record from before a restart, with a later version.
    a.mesh.acceptJoin({ code: a.mesh.invite().code, record: { ...a.mesh.self(), version: ahead } });
    expect(a.mesh.self().version).toBeGreaterThan(ahead);

    const b = startNode(network, "b");
    expect(() =>
      a.mesh.acceptJoin({
        code: a.mesh.invite().code,
        record: { ...b.mesh.self(), version: Date.now() + 9e12 },
      }),
    ).toThrow(expect.objectContaining({ code: "JOIN_INVALID" }));
  });

  it("refuses an invite after it expired", async () => {
    let clock = Date.now();
    const network = createMemoryNetwork();
    const a = startNode(network, "a", { now: () => clock });
    const b = startNode(network, "b");
    const { code } = a.mesh.invite();

    clock += 16 * 60 * 1000;

    await expect(b.mesh.join(a.address, code)).rejects.toMatchObject({ code: "INVITE_INVALID" });
  });

  it("fails a relayed call with MESH_TIMEOUT when no answer comes back in time", async () => {
    const network = createMemoryNetwork();
    // The deadline is the behaviour under test: the test awaits the rejection, not time.
    const a = startNode(network, "a", { callDeadlineMs: 20 });
    const b = startNode(network, "b", { execute: () => new Promise(() => undefined) });
    await b.mesh.join(a.address, a.mesh.invite().code);
    await until([a, b], () => view(a, b)?.linked === true);
    await expect(a.mesh.call("b", "app.never", {})).rejects.toMatchObject({ code: "MESH_TIMEOUT" });
  });

  it("lets a new inbound link from a node supersede its older one", async () => {
    const network = createMemoryNetwork();
    const a = startNode(network, "a", { advertise: false });
    const b = startNode(network, "b", { advertise: false });
    a.mesh.acceptJoin({ code: a.mesh.invite().code, record: b.mesh.self() });

    // Two connections from b to a, each answered by its own handler.
    const serveAs = (name: string) => {
      const [mine, theirs] = createPeerPair();
      serveRpc(mine, {
        caller: { id: "a", permissions: ["*"] },
        logger: noopLogger,
        hello: () => ({}),
        newTraceId: () => "t",
        execute: async () => ({ via: name }),
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        mine.onClose(resolve),
      );
      a.mesh.accept(theirs, "b");
      return closed;
    };
    const firstClosed = serveAs("first");
    void serveAs("second");

    expect(await firstClosed).toMatchObject({ code: 1000, reason: "superseded" });
    expect(await a.mesh.call("b", "app.which", {})).toEqual({ via: "second" });
  });

  it("ignores remembered members that are malformed or from the far future", () => {
    const network = createMemoryNetwork();
    const keys = Crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    const good = {
      nodeId: "g",
      publicKey,
      name: "g",
      urls: [],
      neighbors: [],
      version: Date.now(),
    };
    const mesh = createMesh({
      identity: { nodeId: "a", publicKey, name: "a" },
      sign: () => "",
      verify: () => false,
      transport: network.transport("mem://a"),
      execute: async () => null,
      logger: noopLogger,
      members: [
        good,
        { nodeId: 5 } as never,
        { ...good, nodeId: "future", version: Date.now() + 9e12 },
      ],
    });
    meshes.push(mesh);

    expect(mesh.members().map((member) => member.record.nodeId)).toEqual(["a", "g"]);
  });

  it("mirrors a stream of a node two hops away, through the node between, and keeps it when the owner leaves", async () => {
    const network = createMemoryNetwork();
    network.block("mem://a", "mem://c");
    const { a, b, c } = await chain(network);
    const turn = (n: number) => ({ type: "agent.item.delta", payload: { n } });
    await c.log.append("thread/1", [turn(1), turn(2), turn(3)]);

    const local = a.mesh.mirror("c", "thread/1");
    expect(local).toBe("mirror/c/thread/1");
    await headReaches(a.log, local, 3);

    // b keeps its own copy: it is what a reads from.
    expect(await b.log.head("mirror/c/thread/1")).toBe(3);
    expect((await a.log.read(local)).map((event) => [event.sequence, event.payload])).toEqual([
      [1, { n: 1 }],
      [2, { n: 2 }],
      [3, { n: 3 }],
    ]);

    // c leaves; its history stays readable on a; what c writes meanwhile arrives when it returns.
    network.down(c.address);
    await c.log.append("thread/1", [turn(4), turn(5)]);
    expect(await a.log.head(local)).toBe(3);
    network.up(c.address);
    await headReaches(a.log, local, 5);
    expect((await a.log.read(local, { after: 3 })).map((event) => event.sequence)).toEqual([4, 5]);
  });

  it("attaches a mirror opened while the owner was away once a route appears", async () => {
    const network = createMemoryNetwork();
    network.block("mem://a", "mem://c");
    const { a, c, all } = await chain(network);
    network.down(c.address);
    await until(all, () => view(a, c)?.reachable === false);
    await c.log.append("thread/9", [{ type: "agent.item.delta", payload: 1 }]);

    const local = a.mesh.mirror("c", "thread/9");
    network.up(c.address);

    await headReaches(a.log, local, 1);
  });

  it("repairs a gap left by a failed append", async () => {
    const network = createMemoryNetwork();
    const base = createMemoryStorage().log;
    let failures = 1;
    const flaky: EventLog = {
      ...base,
      append: (stream, events, options) => {
        if (stream.startsWith("mirror/") && failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("disk hiccup"));
        }
        return base.append(stream, events, options);
      },
    };
    const a = startNode(network, "a", { log: flaky });
    const b = startNode(network, "b");
    await b.mesh.join(a.address, a.mesh.invite().code);
    await until([a, b], () => view(a, b)?.reachable === true);
    await b.log.append(
      "thread/1",
      [1, 2, 3].map((n) => ({ type: "agent.item.delta", payload: n })),
    );

    const local = a.mesh.mirror("b", "thread/1");
    await headReaches(flaky, local, 3);
    expect((await flaky.read(local)).map((event) => event.payload)).toEqual([1, 2, 3]);
  });

  it("keeps a copy for a neighbor only of a member's stream", async () => {
    const network = createMemoryNetwork();
    const { a, b } = await chain(network);
    // b asks a over their link, as the next hop of a relayed mirror would.
    const link = await (async () => {
      const [mine, theirs] = createPeerPair();
      a.mesh.accept(theirs, "b");
      serveRpc(mine, {
        caller: { id: "a", permissions: ["*"] },
        logger: noopLogger,
        hello: () => ({}),
        newTraceId: () => "t",
        execute: async () => null,
      });
      return createCaller(mine);
    })();
    await expect(
      link.call("mesh.mirror", { owner: "nobody", stream: "thread/1" }),
    ).rejects.toMatchObject({
      code: "MIRROR_INVALID",
    });
    expect(await link.call("mesh.mirror", { owner: "c", stream: "thread/1" })).toEqual({
      stream: "mirror/c/thread/1",
    });
    void b;
  });

  it("copies only shared streams", async () => {
    const network = createMemoryNetwork();
    const a = startNode(network, "a");

    expect(() => a.mesh.mirror("b", "mesh/outbox")).toThrow(
      expect.objectContaining({ code: "STREAM_NOT_MIRRORABLE" }),
    );
    expect(a.mesh.mirror("b", "thread/1")).toBe("mirror/b/thread/1");
  });

  it("remembers opened mirrors and resumes them in a new run", async () => {
    const network = createMemoryNetwork();
    let saved: readonly { owner: string; stream: string }[] = [];
    const sharedLog = createMemoryStorage().log;
    const first = startNode(network, "a", {
      log: sharedLog,
      persistMirrors: (mirrors) => void (saved = mirrors),
    });
    first.mesh.mirror("b", "thread/7");
    expect(saved).toEqual([{ owner: "b", stream: "thread/7" }]);
    first.mesh.unmirror("b", "thread/7");
    expect(saved).toEqual([]);
    first.mesh.mirror("b", "thread/7");
    first.mesh.dispose();

    // A new run of a with the remembered list keeps copying b's thread.
    const a = startNode(network, "a", { log: sharedLog, mirrors: [...saved] });
    const b = startNode(network, "b");
    await b.log.append("thread/7", [{ type: "agent.item.delta", payload: "x" }]);
    await b.mesh.join(a.address, a.mesh.invite().code);
    await headReaches(sharedLog, "mirror/b/thread/7", 1);
  });
});

/** Resolves once `stream` in `log` holds `count` events: waits on appends, not time. */
function headReaches(log: EventLog, stream: string, count: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () =>
      void log.head(stream).then((head) => {
        if (head < count) return;
        subscription.dispose();
        resolve();
      });
    const subscription = log.subscribe(stream, check);
    check();
  });
}
