import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { definePlugin } from "@jhin/sdk";
import type { EventLog, KeyValueStore } from "@jhin/storage-api";
import { describeStorageContract } from "@jhin/storage-api/contract";
import { createTestKernel, mockCapability, testManifest } from "@jhin/testing";
import { describe, expect, it } from "vite-plus/test";

import plugin, { openSqliteStorage } from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;
const tempDir = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-sqlite-"));

describeStorageContract("sqlite", async () => {
  const file = Path.join(tempDir(), "test.db");
  let storage = openSqliteStorage(file);
  return {
    kv: storage.kv,
    log: storage.log,
    restart: async () => {
      storage.close();
      storage = openSqliteStorage(file);
      return storage;
    },
  };
});

describe("jhin.storage-sqlite plugin", () => {
  it("provides both capabilities and keeps data across a node restart", async () => {
    const data = tempDir();
    const hostPaths = mockCapability("host.paths", {
      dataDir: (id: string) => Path.join(data, id),
    });
    Fs.mkdirSync(Path.join(data, "jhin.storage-sqlite"), { recursive: true });
    let kv: KeyValueStore | undefined;
    let log: EventLog | undefined;
    const consumer = {
      manifest: testManifest("app.consumer", {
        requires: { "storage.kv": "^1", "storage.eventlog": "^1" },
      }),
      definition: definePlugin({
        activate(context) {
          kv = context.services.get("storage.kv");
          log = context.services.get("storage.eventlog");
        },
      }),
    };

    const first = await createTestKernel({
      plugins: [hostPaths, { manifest, definition: plugin }, consumer],
    });
    await kv!.set("app", "greeting", "hi");
    await log!.append("thread/1", [{ type: "app.said", payload: "hello" }]);
    await first.stop();

    const second = await createTestKernel({
      plugins: [hostPaths, { manifest, definition: plugin }, consumer],
    });
    expect(await kv!.get("app", "greeting")).toBe("hi");
    expect(await log!.read("thread/1")).toMatchObject([
      { sequence: 1, type: "app.said", payload: "hello" },
    ]);
    expect(Fs.existsSync(Path.join(data, "jhin.storage-sqlite", "jhin.db"))).toBe(true);
    await second.stop();
  });

  it("reports a corrupt stored value as CORRUPT with its location", async () => {
    const file = Path.join(tempDir(), "corrupt.db");
    openSqliteStorage(file).close();
    const raw = new DatabaseSync(file);
    raw
      .prepare("INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?)")
      .run("app", "bad", "{oops");
    raw.close();

    const storage = openSqliteStorage(file);
    await expect(storage.kv.get("app", "bad")).rejects.toMatchObject({
      code: "CORRUPT",
      details: { namespace: "app", key: "bad" },
    });
    storage.close();
  });

  it("lets two storages open the same new file", async () => {
    const file = Path.join(tempDir(), "shared.db");
    const one = openSqliteStorage(file);
    const two = openSqliteStorage(file);

    await one.log.append("s", [{ type: "app.a", payload: 1 }]);
    await two.log.append("s", [{ type: "app.b", payload: 2 }]);

    expect((await one.log.read("s")).map((event) => event.sequence)).toEqual([1, 2]);
    one.close();
    two.close();
  });
});
