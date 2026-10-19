import type { Connections, NodeConnection, NodeTarget } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { createNodeMachines, parseIdentity } from "../src/lib/machines.ts";

const A = "ws://a/rpc";
const B = "ws://b/rpc";

const identity = (machine: string, extra: Record<string, unknown> = {}) => ({
  nodeId: "n",
  hostname: "box",
  platform: "linux",
  arch: "x64",
  machine,
  ...extra,
});

/** Connections whose states the test sets, and a `host.identity` the test answers by hand. */
function world() {
  let states: Record<string, NodeConnection["state"]> = { [A]: "open", [B]: "open" };
  const listeners = new Set<() => void>();
  const connections: Pick<Connections, "list" | "subscribe"> = {
    list: () =>
      Object.entries(states).map(
        ([id, state]) =>
          ({ id, url: id, label: id, state, client: {} }) as unknown as NodeConnection,
      ),
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
  const calls: {
    target: NodeTarget;
    method: string;
    answer(value: unknown): Promise<void>;
    fail(): Promise<void>;
  }[] = [];
  const threads = {
    call<T>(target: NodeTarget, method: string): Promise<T> {
      let settle!: (outcome: { value?: unknown; error?: Error }) => void;
      const promise = new Promise<T>((resolve, reject) => {
        settle = ({ value, error }) => (error === undefined ? resolve(value as T) : reject(error));
      });
      calls.push({
        target,
        method,
        // Resolves once the store has handled the answer.
        answer: async (value) => {
          settle({ value });
          await promise.then(flush, flush);
        },
        fail: async () => {
          settle({ error: new Error("unknown method host.identity") });
          await promise.then(flush, flush);
        },
      });
      return promise;
    },
  };
  return {
    connections,
    threads,
    calls,
    setState(id: string, state: NodeConnection["state"]) {
      states = { ...states, [id]: state };
      for (const listener of Array.from(listeners)) listener();
    },
    remove(id: string) {
      const { [id]: _removed, ...rest } = states;
      states = rest;
      for (const listener of Array.from(listeners)) listener();
    },
    listeners,
  };
}

/** The store's own `then` runs one turn after the call's promise settles. */
const flush = () => Promise.resolve();

describe("what a node says it is (host.identity)", () => {
  it("reads the kind, and a kind this client does not know as a server", () => {
    expect(parseIdentity(identity("laptop", { detectedMachine: "cloud" }))).toEqual({
      kind: "laptop",
      detected: "cloud",
      hostname: "box",
      platform: "linux",
    });
    expect(parseIdentity(identity("toaster", { detectedMachine: "fridge" }))).toEqual({
      kind: "server",
      hostname: "box",
      platform: "linux",
    });
    expect(parseIdentity({ nope: true })).toBeUndefined();
  });
});

describe("client.machines", () => {
  it("asks each node once, however many follow it, and tells them its kind", async () => {
    const w = world();
    const machines = createNodeMachines(w.connections, w.threads);
    const remote = { node: A, remote: "b" };
    let told = 0;
    const one = machines.subscribe({ node: A }, () => told++);
    const two = machines.subscribe({ node: A }, () => told++);
    machines.subscribe(remote, () => undefined);
    expect(w.calls.map((call) => [call.target, call.method])).toEqual([
      [{ node: A }, "host.identity"],
      [remote, "host.identity"],
    ]);
    expect(machines.get({ node: A })).toBeUndefined();

    await w.calls[0]!.answer(identity("laptop"));
    expect(told).toBe(2);
    expect(machines.get({ node: A })?.kind).toBe("laptop");
    expect(machines.get(remote)).toBeUndefined();
    await w.calls[1]!.answer(identity("cloud"));
    expect(machines.get(remote)?.kind).toBe("cloud");

    // The same answer again changes nothing, and keeps the object.
    const known = machines.get({ node: A });
    machines.refresh({ node: A });
    await w.calls[2]!.answer(identity("laptop"));
    await w.calls[3]!.answer(identity("cloud"));
    expect(told).toBe(2);
    expect(machines.get({ node: A })).toBe(known);

    one.dispose();
    two.dispose();
    // Nobody follows the node: the store forgets it.
    expect(machines.get({ node: A })).toBeUndefined();
  });

  it("asks again when a connection opens again, and keeps what it knew meanwhile", async () => {
    const w = world();
    const machines = createNodeMachines(w.connections, w.threads);
    machines.subscribe({ node: A }, () => undefined);
    machines.subscribe({ node: B }, () => undefined);
    await w.calls[0]!.answer(identity("laptop"));
    await w.calls[1]!.answer(identity("desktop"));

    w.setState(A, "connecting");
    expect(w.calls).toHaveLength(2);
    expect(machines.get({ node: A })?.kind).toBe("laptop");
    w.setState(A, "open");
    expect(w.calls.map((call) => call.target)).toEqual([{ node: A }, { node: B }, { node: A }]);
    await w.calls[2]!.answer(identity("mac-mini"));
    expect(machines.get({ node: A })?.kind).toBe("mac-mini");
    expect(machines.get({ node: B })?.kind).toBe("desktop");
  });

  it("keeps the newest answer, and what it knew when a node cannot answer", async () => {
    const w = world();
    const machines = createNodeMachines(w.connections, w.threads);
    machines.subscribe({ node: A }, () => undefined);
    machines.refresh({ node: A });
    // The second request answers first; the first one's late answer is old news.
    await w.calls[1]!.answer(identity("desktop"));
    await w.calls[0]!.answer(identity("laptop"));
    expect(machines.get({ node: A })?.kind).toBe("desktop");

    machines.refresh({ node: A });
    await w.calls[2]!.fail();
    expect(machines.get({ node: A })?.kind).toBe("desktop");
  });

  it("does not ask a node that could not answer again for every new view, only on reconnect or refresh", async () => {
    const w = world();
    const machines = createNodeMachines(w.connections, w.threads);
    machines.subscribe({ node: A }, () => undefined);
    // An older node: no host.identity. It shows as a server.
    await w.calls[0]!.fail();
    expect(machines.get({ node: A })).toBeUndefined();
    // Cards and rows that mount later do not send a request that cannot succeed.
    machines.subscribe({ node: A }, () => undefined);
    machines.subscribe({ node: A }, () => undefined);
    expect(w.calls).toHaveLength(1);

    machines.refresh({ node: A });
    expect(w.calls).toHaveLength(2);
    await w.calls[1]!.fail();
    w.setState(A, "connecting");
    w.setState(A, "open");
    expect(w.calls).toHaveLength(3);
    await w.calls[2]!.answer(identity("server"));
    expect(machines.get({ node: A })?.kind).toBe("server");
  });

  it("forgets a removed connection, so one added again under its id counts as reopened", async () => {
    const w = world();
    const machines = createNodeMachines(w.connections, w.threads);
    machines.subscribe({ node: A }, () => undefined);
    machines.subscribe({ node: B }, () => undefined);
    await w.calls[0]!.answer(identity("laptop"));
    await w.calls[1]!.answer(identity("desktop"));
    w.remove(B);
    // Added again, already open: its node may be another machine now.
    w.setState(B, "open");
    expect(w.calls.map((call) => call.target)).toEqual([{ node: A }, { node: B }, { node: B }]);
    await w.calls[2]!.answer(identity("mac-studio"));
    expect(machines.get({ node: B })?.kind).toBe("mac-studio");
  });

  it("refreshes every followed node behind a connection, or one remote of it", async () => {
    const w = world();
    const machines = createNodeMachines(w.connections, w.threads);
    for (const target of [
      { node: A },
      { node: A, remote: "b" },
      { node: A, remote: "c" },
      { node: B },
    ])
      machines.subscribe(target, () => undefined);
    w.calls.length = 0;
    machines.refresh({ node: A, remote: "c" });
    expect(w.calls.map((call) => call.target)).toEqual([{ node: A, remote: "c" }]);
    machines.refresh({ node: A });
    expect(w.calls.map((call) => call.target).slice(1)).toEqual([
      { node: A },
      { node: A, remote: "b" },
      { node: A, remote: "c" },
    ]);
  });

  it("stops following the connections once nobody follows a node, and when disposed", () => {
    const w = world();
    const machines = createNodeMachines(w.connections, w.threads);
    const one = machines.subscribe({ node: A }, () => undefined);
    expect(w.listeners.size).toBe(1);
    one.dispose();
    expect(w.listeners.size).toBe(0);
    machines.subscribe({ node: A }, () => undefined);
    machines.dispose();
    expect(w.listeners.size).toBe(0);
  });

  it("tells every listener even when one of them throws", async () => {
    const w = world();
    const errors: unknown[] = [];
    const machines = createNodeMachines(w.connections, w.threads, (error) => errors.push(error));
    let told = false;
    machines.subscribe({ node: A }, () => {
      throw new Error("faulty plugin");
    });
    machines.subscribe({ node: A }, () => (told = true));
    await w.calls[0]!.answer(identity("laptop"));
    expect(told).toBe(true);
    expect(errors).toHaveLength(1);
  });
});
