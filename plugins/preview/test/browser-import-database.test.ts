// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/CookieDatabase.test.ts. docs/plans/preview.md, D1204.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { snapshotCookieDatabase, withDatabase } from "../src/browser-import/cookie-database.ts";
import { tempDirectory } from "./browser-import-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function source(): string {
  const directory = tempDirectory("jhin-cookie-source-");
  cleanups.push(directory.remove);
  return Path.join(directory.path, "Cookies");
}

describe("snapshotCookieDatabase", () => {
  it("includes committed WAL data in one consistent database", () => {
    const file = source();
    // The browser holds the database open in WAL mode, its last writes not yet checkpointed.
    const browser = new DatabaseSync(file);
    cleanups.push(() => browser.close());
    browser.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    browser.exec("CREATE TABLE cookies(name TEXT NOT NULL)");
    browser.prepare("INSERT INTO cookies(name) VALUES (?)").run("committed-in-wal");
    expect(Fs.existsSync(`${file}-wal`)).toBe(true);

    const snapshot = snapshotCookieDatabase(file);
    cleanups.push(snapshot.dispose);
    expect(
      withDatabase(snapshot.path, (database) => database.prepare("SELECT name FROM cookies").all()),
    ).toEqual([{ name: "committed-in-wal" }]);
  });

  it("throws a failed snapshot and removes its temporary folder", () => {
    const file = source();
    Fs.writeFileSync(file, "not a sqlite database");
    const prefix = `jhin-cookie-failed-${process.pid}-`;
    expect(() => snapshotCookieDatabase(file, prefix)).toThrow();
    expect(Fs.readdirSync(Os.tmpdir()).some((entry) => entry.startsWith(prefix))).toBe(false);
  });

  it("removes a snapshot once disposed", () => {
    const file = source();
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE cookies(name TEXT NOT NULL)");
    database.close();
    const snapshot = snapshotCookieDatabase(file);
    expect(Fs.existsSync(snapshot.path)).toBe(true);
    snapshot.dispose();
    expect(Fs.existsSync(snapshot.path)).toBe(false);
  });
});
