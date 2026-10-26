import { describe, expect, it } from "vite-plus/test";

import { node } from "./support.ts";

type Epoch = { epoch: string; head: number };

describe("the database's epoch (loading.md D1590)", () => {
  it("is one id across threads.epoch, threads.catalog and threads.get, and stays after a restart", async () => {
    const first = await node();
    const { epoch } = await first.client.call<Epoch>("threads.epoch", {});
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/);
    await first.client.call("threads.create", { threadId: "kept" });
    expect(await first.client.call<Epoch>("threads.catalog", {})).toMatchObject({ epoch });
    expect(await first.client.call<Epoch>("threads.get", { threadId: "kept" })).toMatchObject({
      epoch,
    });
    const { head } = await first.client.call<Epoch>("threads.epoch", {});
    expect(head).toBeGreaterThan(0);
    await first.stop();

    const again = await node({ storage: first.storage, data: first.data });
    expect(await again.client.call<Epoch>("threads.epoch", {})).toEqual({ epoch, head });
  });

  it("is another id on another database, even under the same home", async () => {
    const first = await node();
    const { epoch } = await first.client.call<Epoch>("threads.epoch", {});
    await first.stop();
    // The same data directory (and so the same node id) on a new database.
    const reinstalled = await node({ data: first.data });
    expect((await reinstalled.client.call<Epoch>("threads.epoch", {})).epoch).not.toBe(epoch);
  });

  it("is one id for two processes that share the storage and ask at once", async () => {
    const one = await node();
    const two = await node({ storage: one.storage, data: one.data });
    const [a, b] = await Promise.all([
      one.client.call<Epoch>("threads.epoch", {}),
      two.client.call<Epoch>("threads.epoch", {}),
    ]);
    expect(a.epoch).toBe(b.epoch);
  });
});
