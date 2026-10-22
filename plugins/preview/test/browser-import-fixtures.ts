// Fixtures of the machine's browsers for the cookie import's tests (D1204), after T3 Code's
// (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/BrowserImport/*.test.ts.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ImportHost, RunResult } from "../src/browser-import/host.ts";

/** A temporary folder, removed by the returned function. */
export function tempDirectory(prefix: string): { path: string; remove(): void } {
  const path = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix));
  return { path, remove: () => Fs.rmSync(path, { recursive: true, force: true }) };
}

export interface FirefoxRow {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number;
  isSecure: number;
  isHttpOnly: number;
  sameSite: number | null;
  rawSameSite?: number;
  originAttributes?: string;
}

/**
 * A Firefox-shaped `cookies.sqlite`. Firefox stamps `PRAGMA user_version`;
 * schema 16+ keeps `expiry` in milliseconds, earlier ones in seconds, and only
 * schemas 10–14 have `rawSameSite`.
 */
export function writeFirefoxCookieDatabase(
  file: string,
  rows: ReadonlyArray<FirefoxRow>,
  schemaVersion = 15,
): string {
  Fs.mkdirSync(Path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`pragma user_version = ${schemaVersion}`);
  const hasRawSameSite = schemaVersion >= 10 && schemaVersion <= 14;
  database.exec(
    `create table moz_cookies (
       id integer primary key, host text, name text, value text, path text,
       expiry integer, isSecure integer, isHttpOnly integer, sameSite integer,
       ${hasRawSameSite ? "rawSameSite integer," : ""}
       originAttributes text not null default ''
     )`,
  );
  const insert = database.prepare(
    `insert into moz_cookies
       (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite,
        ${hasRawSameSite ? "rawSameSite," : ""} originAttributes)
     values (?, ?, ?, ?, ?, ?, ?, ?, ${hasRawSameSite ? "?," : ""} ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.host,
      row.name,
      row.value,
      row.path,
      row.expiry,
      row.isSecure,
      row.isHttpOnly,
      row.sameSite,
      ...(hasRawSameSite ? [row.rawSameSite ?? row.sameSite] : []),
      row.originAttributes ?? "",
    );
  }
  database.close();
  return file;
}

export interface ChromiumRow {
  host_key: string;
  name: string;
  value?: string;
  encrypted_value?: Uint8Array;
  path?: string;
  expires_utc?: number | bigint;
  is_secure?: number;
  is_httponly?: number;
  samesite?: number;
  top_frame_site_key?: string;
}

/** A Chromium-shaped `Cookies` database; schemas before 15 have no `top_frame_site_key`. */
export function writeChromiumCookieDatabase(
  file: string,
  rows: ReadonlyArray<ChromiumRow>,
  version: number | string = 23,
): string {
  Fs.mkdirSync(Path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  const partitioned = typeof version !== "number" || version >= 15;
  database.exec("create table meta (key text primary key, value text not null)");
  database.prepare("insert into meta values ('version', ?)").run(String(version));
  database.exec(
    `create table cookies (
       host_key text not null, name text not null, value text not null,
       encrypted_value blob not null, path text not null, expires_utc integer not null,
       is_secure integer not null, is_httponly integer not null, samesite integer not null
       ${partitioned ? ", top_frame_site_key text not null default ''" : ""}
     )`,
  );
  const insert = database.prepare(
    `insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure,
       is_httponly, samesite${partitioned ? ", top_frame_site_key" : ""})
     values (?, ?, ?, ?, ?, ?, ?, ?, ?${partitioned ? ", ?" : ""})`,
  );
  for (const row of rows) {
    insert.run(
      row.host_key,
      row.name,
      row.value ?? "",
      row.encrypted_value ?? new Uint8Array(),
      row.path ?? "/",
      row.expires_utc ?? 0,
      row.is_secure ?? 0,
      row.is_httponly ?? 0,
      row.samesite ?? -1,
      ...(partitioned ? [row.top_frame_site_key ?? ""] : []),
    );
  }
  database.close();
  return file;
}

/** OSCrypt's AES-128-CBC with its IV of 16 spaces. */
export function encryptChromium(
  prefix: "v10" | "v11",
  value: string | Buffer,
  key: Buffer,
): Uint8Array {
  const cipher = Crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix), cipher.update(value), cipher.final()]);
}

/** Windows' legacy v10: AES-256-GCM with nonce and tag. */
export function encryptWindowsV10(value: string | Buffer, key: Buffer): Uint8Array {
  const nonce = Buffer.from("0123456789ab");
  const cipher = Crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, encrypted, cipher.getAuthTag()]);
}

export interface FixtureCookie {
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  readonly value: string;
  readonly flags: number;
  readonly expiry: number;
}

export function encodeSafariCookie(cookie: FixtureCookie): Buffer {
  const strings = [cookie.domain, cookie.name, cookie.path, cookie.value];
  const headerSize = 56;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const value of strings) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(value) + 1;
  }
  const buffer = Buffer.alloc(cursor);
  buffer.writeUInt32LE(cursor, 0);
  buffer.writeUInt32LE(cookie.flags, 8);
  buffer.writeUInt32LE(offsets[0]!, 16);
  buffer.writeUInt32LE(offsets[1]!, 20);
  buffer.writeUInt32LE(offsets[2]!, 24);
  buffer.writeUInt32LE(offsets[3]!, 28);
  buffer.writeDoubleLE(cookie.expiry, 40);
  strings.forEach((value, index) => buffer.write(value, offsets[index]!, "utf8"));
  return buffer;
}

/** One page of Safari's jar with these records. */
export function encodeSafariPage(records: ReadonlyArray<Buffer>): Buffer {
  const headerSize = 12 + records.length * 4;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const record of records) {
    offsets.push(cursor);
    cursor += record.length;
  }
  const page = Buffer.alloc(cursor);
  page.writeUInt32BE(0x0000_0100, 0);
  page.writeUInt32LE(records.length, 4);
  offsets.forEach((offset, index) => page.writeUInt32LE(offset, 8 + index * 4));
  records.forEach((record, index) => record.copy(page, offsets[index]!));
  return page;
}

/** A whole `Cookies.binarycookies` of these pages, with an optional trailer. */
export function encodeSafariJar(pages: ReadonlyArray<Buffer>, trailer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8 + pages.length * 4);
  header.write("cook", 0, "latin1");
  header.writeUInt32BE(pages.length, 4);
  pages.forEach((page, index) => header.writeUInt32BE(page.length, 8 + index * 4));
  return Buffer.concat([header, ...pages, trailer]);
}

export const encodeBinaryCookies = (cookies: ReadonlyArray<FixtureCookie>): Buffer =>
  encodeSafariJar([encodeSafariPage(cookies.map(encodeSafariCookie))]);

export type FakeRun = (
  command: string,
  args: readonly string[],
  stdin: string | undefined,
) => Promise<RunResult> | RunResult;

interface FakeCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A machine with a home of the test's, programs answered by `run`, and no other process alive. */
export function fakeHost(options: {
  platform?: NodeJS.Platform;
  home: string;
  env?: NodeJS.ProcessEnv;
  run?: FakeRun;
  hostname?: string;
  addresses?: ReadonlySet<string>;
  alive?: (pid: number) => boolean;
}): ImportHost & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    platform: options.platform ?? "linux",
    env: { HOME: options.home, ...options.env },
    hostname: () => options.hostname ?? "test-host",
    addresses: async () => options.addresses ?? new Set(["127.0.0.1"]),
    async run(command, args, runOptions) {
      calls.push({ command, args, stdin: runOptions?.stdin });
      if (options.run === undefined) {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      }
      return options.run(command, args, runOptions?.stdin);
    },
    isProcessAlive: (pid) => options.alive?.(pid) ?? false,
  };
}

export const ran = (exitCode: number, stdout = "", stderr = ""): RunResult => ({
  exitCode,
  stdout: Buffer.from(stdout),
  stderr,
});
