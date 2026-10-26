import type { StreamEvent } from "@jhin/client-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DATABASE,
  openHistoryStore,
  type HistoryStore,
} from "../src/plugins/history-cache/store.ts";

const event = (stream: string, sequence: number): StreamEvent => ({
  stream,
  sequence,
  type: "agent.turn.message",
  payload: { text: `event ${sequence}` },
  at: "2026-10-24T00:00:00.000Z",
});
const range = (stream: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => event(stream, from + index));

const deleteDatabase = () =>
  new Promise<void>((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(DATABASE);
    deleting.addEventListener("success", () => resolve());
    deleting.addEventListener("error", () => reject(deleting.error));
  });

let store: HistoryStore | undefined;
afterEach(async () => {
  store?.close();
  store = undefined;
  await deleteDatabase();
});

describe("the history cache's IndexedDB store (loading.md D1588, D1590)", () => {
  it("keeps a stream's events across opening the database again, and marks it opened", async () => {
    store = openHistoryStore();
    await store.append("node", "thread/a", "e1", range("thread/a", 1, 2), 100);
    await store.append("node", "thread/a", "e1", range("thread/a", 2, 4), 100);
    store.close();
    store = openHistoryStore();
    const kept = await store.read("node", "thread/a", 500);
    expect(kept?.epoch).toBe("e1");
    expect(kept?.lastSequence).toBe(4);
    expect(kept?.events.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    const [entry] = await store.entries();
    expect(entry).toMatchObject({ connection: "node", stream: "thread/a", openedAt: 500 });
    expect(entry!.bytes).toBeGreaterThan(0);
  });

  it("drops a stream when a batch leaves a gap", async () => {
    store = openHistoryStore();
    await store.append("node", "thread/a", "e1", range("thread/a", 1, 2), 0);
    await store.append("node", "thread/a", "e1", range("thread/a", 5, 6), 0);
    expect(await store.read("node", "thread/a", 0)).toBeUndefined();
    expect(await store.entries()).toEqual([]);
  });

  it("keeps nothing that does not start at 1", async () => {
    store = openHistoryStore();
    await store.append("node", "thread/a", "e1", range("thread/a", 3, 4), 0);
    expect(await store.read("node", "thread/a", 0)).toBeUndefined();
  });

  it("replaces what another epoch kept with a stream read from 1", async () => {
    store = openHistoryStore();
    await store.append("node", "thread/a", "old", range("thread/a", 1, 5), 0);
    await store.append("node", "thread/a", "new", range("thread/a", 1, 2), 0);
    const kept = await store.read("node", "thread/a", 0);
    expect(kept).toMatchObject({ epoch: "new", lastSequence: 2 });
    expect(kept?.events).toHaveLength(2);
  });

  it("forgets one stream, one connection's streams, or everything", async () => {
    store = openHistoryStore();
    await store.append("one", "thread/a", "e1", range("thread/a", 1, 1), 0);
    await store.append("one", "thread/b", "e1", range("thread/b", 1, 1), 0);
    await store.append("two", "thread/a", "e2", range("thread/a", 1, 1), 0);
    await store.drop("one", "thread/a");
    expect((await store.entries()).map((entry) => `${entry.connection} ${entry.stream}`)).toEqual([
      "one thread/b",
      "two thread/a",
    ]);
    await store.drop("one");
    expect((await store.entries()).map((entry) => entry.connection)).toEqual(["two"]);
    expect(await store.read("two", "thread/a", 0)).toMatchObject({ lastSequence: 1 });
    await store.drop();
    expect(await store.entries()).toEqual([]);
  });

  it("keeps a connection's catalog, and forgets it with the connection or everything (D1591)", async () => {
    store = openHistoryStore();
    const catalog = { epoch: "e1", head: 4, projects: [], threads: [] };
    await store.writeCatalog("one", catalog);
    await store.writeCatalog("two", { ...catalog, head: 9 });
    await store.append("one", "thread/a", "e1", range("thread/a", 1, 1), 0);
    expect(await store.readCatalog("one")).toEqual(catalog);
    // Dropping one stream leaves the catalog; dropping the connection takes it.
    await store.drop("one", "thread/a");
    expect(await store.readCatalog("one")).toEqual(catalog);
    await store.drop("one");
    expect(await store.readCatalog("one")).toBeUndefined();
    expect(await store.readCatalog("two")).toMatchObject({ head: 9 });
    await store.drop();
    expect(await store.readCatalog("two")).toBeUndefined();
  });

  it("upgrades a version 1 database and keeps its streams", async () => {
    // What version 1 wrote: the streams and their events, no catalogs.
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(DATABASE, 1);
      opening.addEventListener("upgradeneeded", () => {
        const db = opening.result;
        db.createObjectStore("streams", { keyPath: ["connection", "stream"] });
        db.createObjectStore("events");
      });
      opening.addEventListener("error", () => reject(opening.error));
      opening.addEventListener("success", () => {
        const db = opening.result;
        const tx = db.transaction(["streams", "events"], "readwrite");
        tx.objectStore("streams").put({
          connection: "node",
          stream: "thread/a",
          epoch: "e1",
          lastSequence: 1,
          openedAt: 0,
          bytes: 10,
        });
        tx.objectStore("events").put(event("thread/a", 1), ["node", "thread/a", 1]);
        tx.addEventListener("complete", () => {
          db.close();
          resolve();
        });
        tx.addEventListener("error", () => reject(tx.error));
      });
    });
    store = openHistoryStore();
    expect(await store.read("node", "thread/a", 0)).toMatchObject({ epoch: "e1", lastSequence: 1 });
    expect(await store.readCatalog("node")).toBeUndefined();
    await store.writeCatalog("node", { epoch: "e1", head: 1, projects: [], threads: [] });
    expect(await store.readCatalog("node")).toMatchObject({ head: 1 });
  });

  it("reads no catalog from a record that is not one", async () => {
    store = openHistoryStore();
    await store.writeCatalog("node", { epoch: "e1", head: 1 } as never);
    expect(await store.readCatalog("node")).toBeUndefined();
  });
});
