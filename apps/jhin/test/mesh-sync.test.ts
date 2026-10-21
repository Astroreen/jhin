import type { StoredEvent } from "@jhin/storage-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  joinThrough,
  makeHome,
  reachable,
  serve,
  untilMesh,
  untilStream,
  type Node,
} from "./support/nodes.ts";

const running: Node[] = [];
afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

const types = (events: readonly StoredEvent[]) => events.map((event) => event.type);
const completed = (events: readonly StoredEvent[]) =>
  types(events).includes("agent.turn.completed");

/** a and c have no address: everything between them goes through b. */
async function trio(aMesh: Record<string, unknown> = {}) {
  const homeC = makeHome("c", { advertise: [] });
  const a = await serve("a", makeHome("a", { advertise: [], ...aMesh }), running);
  const b = await serve("b", makeHome("b"), running);
  const c = await serve("c", homeC, running);
  await joinThrough(b, [a, c]);
  await untilMesh(a, reachable(c));
  return { a, b, c, homeC };
}

// Each test starts three node processes; the limit bounds the run, nothing waits on time.
const LIMIT = { timeout: 60_000 };

describe("history sync (D26)", () => {
  it(
    "on-open: copies a thread of c to a when opened, live, and keeps it after c leaves",
    LIMIT,
    async () => {
      const { a, c } = await trio();
      const thread = await a.client.call<{ id: string }>("mesh.call", {
        node: c.nodeId,
        method: "threads.create",
        params: { title: "Remote" },
      });
      const { stream } = await a.client.call<{ stream: string }>("mesh.open", {
        node: c.nodeId,
        stream: `thread/${thread.id}`,
      });
      expect(stream).toBe(`mirror/${c.nodeId}/thread/${thread.id}`);
      const copied = untilStream(a, stream, completed);

      await a.client.call("mesh.call", {
        node: c.nodeId,
        method: "threads.send",
        params: { threadId: thread.id, text: "hi" },
      });
      const events = await copied;
      expect(types(events)).toEqual([
        "threads.thread.created",
        "agent.turn.started",
        "agent.item.delta",
        "agent.item.delta",
        "agent.item.completed",
        "agent.turn.completed",
      ]);

      await c.stop();
      await untilMesh(a, (nodes) => !reachable(c)(nodes));
      // Still readable on a with c gone: the same events, the same sequences.
      const offline = await untilStream(a, stream, (all) => all.length === events.length);
      expect(offline.map((event) => [event.sequence, event.type])).toEqual(
        events.map((event) => [event.sequence, event.type]),
      );
    },
  );

  it("eager: a keeps every thread of c without opening it", LIMIT, async () => {
    const { a, c } = await trio({ history: "eager" });
    const thread = await c.client.call<{ id: string }>("threads.create", { title: "Made on c" });
    await c.client.call("threads.send", { threadId: thread.id, text: "hello" });

    const stream = `mirror/${c.nodeId}/thread/${thread.id}`;
    const events = await untilStream(a, stream, completed);

    await c.stop();
    await untilMesh(a, (nodes) => !reachable(c)(nodes));
    expect((await untilStream(a, stream, (all) => all.length === events.length)).length).toBe(
      events.length,
    );
  });
});

describe("settings fan-out (D20, D50)", () => {
  it(
    "changes every node, queues the change for a node that is away, and reports a newer local change",
    LIMIT,
    async () => {
      const { a, b, c, homeC } = await trio();
      const greet = (node: Node) =>
        a.client.call<{ message: string }>("mesh.call", {
          node: node.nodeId,
          method: "example.greet",
          params: { name: "x" },
        });

      const first = await a.client.call<{ results: { node: string; status: string }[] }>(
        "mesh.config.patch",
        {
          nodes: "all",
          layer: "node",
          section: "jhin.example",
          values: { greeting: "Hi" },
        },
      );
      expect(first.results.map((result) => result.status)).toEqual([
        "applied",
        "applied",
        "applied",
      ]);
      expect((await greet(c)).message).toBe("Hi, x!");

      await c.stop();
      await untilMesh(a, (nodes) => !reachable(c)(nodes));
      const second = await a.client.call<{ results: { node: string; status: string }[] }>(
        "mesh.config.patch",
        {
          nodes: [b.nodeId, c.nodeId],
          layer: "node",
          section: "jhin.example",
          values: { greeting: "Welcome back" },
        },
      );
      expect(second.results).toEqual([
        { node: b.nodeId, status: "applied" },
        { node: c.nodeId, status: "queued" },
      ]);
      expect(await a.client.call("mesh.config.pending")).toMatchObject([
        { node: c.nodeId, layer: "node", section: "jhin.example" },
      ]);

      // c returns: a delivers the queued change as soon as a route exists.
      const delivered = untilStream(a, "mesh/outbox", (events) =>
        types(events).includes("mesh.config.delivered"),
      );
      const back = await serve("c", homeC, running);
      await delivered;
      expect((await greet(back)).message).toBe("Welcome back, x!");
      expect(await a.client.call("mesh.config.pending")).toEqual([]);

      // A reset removes the key from c's file: it takes its default again (D84).
      const reset = await a.client.call<{ results: { node: string; status: string }[] }>(
        "mesh.config.patch",
        {
          nodes: [back.nodeId],
          layer: "node",
          section: "jhin.example",
          values: {},
          unset: ["greeting"],
        },
      );
      expect(reset.results).toEqual([{ node: back.nodeId, status: "applied" }]);
      expect((await greet(back)).message).toBe("Hello, x!");

      // Edits of leaf paths go through too; values and unset are what older nodes take (D476).
      const edited = await a.client.call<{ results: { node: string; status: string }[] }>(
        "mesh.config.patch",
        {
          nodes: [back.nodeId],
          layer: "node",
          section: "jhin.example",
          values: { greeting: "Not this" },
          edits: [{ path: ["greeting"], value: "Edited" }],
        },
      );
      expect(edited.results).toEqual([{ node: back.nodeId, status: "applied" }]);
      expect((await greet(back)).message).toBe("Edited, x!");

      // A change made on c later than a's wins; a hears about the conflict.
      await back.client.call("host.config.patch", {
        layer: "node",
        section: "jhin.example",
        values: { greeting: "Mine" },
        at: Date.now() + 60_000,
      });
      const third = await a.client.call<{ results: { node: string; status: string }[] }>(
        "mesh.config.patch",
        {
          nodes: [back.nodeId],
          layer: "node",
          section: "jhin.example",
          values: { greeting: "Override" },
        },
      );
      expect(third.results[0]).toMatchObject({ status: "conflict" });
      expect((await greet(back)).message).toBe("Mine, x!");
    },
  );
});
