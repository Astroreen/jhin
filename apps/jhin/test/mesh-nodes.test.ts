import { afterAll, describe, expect, it } from "vite-plus/test";

import { makeHome, serve, untilMesh, type Node, type NodeView } from "./support/nodes.ts";

const running: Node[] = [];
afterAll(async () => {
  for (const node of running.splice(0)) await node.stop();
});

const home = (name: string, mesh: Record<string, unknown>) => makeHome(name, mesh);
const until = untilMesh;

describe("a mesh of real nodes", () => {
  // Four node processes start in this test; the limit bounds the run, nothing waits on time.
  it(
    "joins, relays a → c through b, and finds c again after it restarts",
    { timeout: 60_000 },
    async () => {
      // a and c advertise no address: neither can dial the other, both dial b.
      const homeC = home("c", { advertise: [] });
      const a = await serve("a", home("a", { advertise: [] }), running);
      const b = await serve("b", home("b", {}), running);
      let c = await serve("c", homeC, running);

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
      // A relayed call runs with the mesh's rights (`*`), so a client reaches a member's
      // host.identity through its connection (D130, D132).
      expect(
        await a.client.call("mesh.call", { node: c.nodeId, method: "host.identity", params: {} }),
      ).toMatchObject({ nodeId: c.nodeId, machine: expect.any(String) });
      expect(
        await a.client.call("mesh.resolve", { address: `jhin://${c.nodeId}/threads/42` }),
      ).toMatchObject({
        nodeId: c.nodeId,
        path: "threads/42",
        node: { reachable: true, route: [a.nodeId, b.nodeId, c.nodeId] },
      });

      // D24: /n/<nodeId>/<path> on any node; never a redirect to another host.
      const self = await fetch(`${a.http}/n/${a.nodeId}//evil.example/x?y=1`, {
        redirect: "manual",
      });
      expect(self.status).toBe(307);
      expect(self.headers.get("location")).toBe("/evil.example/x?y=1");
      const relayed = await fetch(`${a.http}/n/${b.nodeId}/threads?z=2`, { redirect: "manual" });
      expect(relayed.headers.get("location")).toBe(`${b.http}/threads?z=2`);

      // Guessing invite codes is cut off after 20 attempts a minute from one address
      // (the two joins above count too; 41 tries cross the limit even across a minute boundary).
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 41; attempt += 1) {
        const response = await fetch(`${b.http}/mesh/join`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "guess", record: {} }),
        });
        statuses.push(response.status);
      }
      const firstRefusal = statuses.indexOf(429);
      expect(firstRefusal).toBeGreaterThan(0);
      expect(statuses.slice(0, firstRefusal).every((status) => status === 400)).toBe(true);

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
      c = await serve("c", homeC, running);
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
