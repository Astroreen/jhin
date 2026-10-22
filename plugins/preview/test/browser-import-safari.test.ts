// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/SafariCookies.test.ts. docs/plans/preview.md, D1204.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CookieReadError } from "../src/browser-import/cookie-database.ts";
import {
  isPermissionDenied,
  parseBinaryCookies,
  readSafariCookies,
  safariAccessDenied,
} from "../src/browser-import/safari-cookies.ts";
import {
  encodeBinaryCookies,
  encodeSafariCookie,
  encodeSafariJar,
  encodeSafariPage,
  tempDirectory,
} from "./browser-import-fixtures.ts";

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const one = (domain: string, name: string) =>
  encodeSafariCookie({ domain, name, path: "/", value: "v", flags: 0, expiry: 1_000 });
/** The first record's offset in a one-page jar: past the 12-byte file header. */
const PAGE_START = 8 + 4;

describe("parseBinaryCookies", () => {
  it("reads Safari's format and rebases its 2001 epoch", () => {
    const file = encodeBinaryCookies([
      {
        domain: ".apple.com",
        name: "session",
        path: "/",
        value: "abc",
        flags: 0x1 | 0x4,
        expiry: 800_000_000,
      },
      { domain: "example.test", name: "plain", path: "/app", value: "v", flags: 0, expiry: 0 },
    ]);
    expect(parseBinaryCookies(file)).toEqual([
      {
        url: "https://apple.com/",
        name: "session",
        value: "abc",
        domain: ".apple.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: 800_000_000 + APPLE_EPOCH_OFFSET_SECONDS,
        sameSite: "lax",
      },
      {
        url: "http://example.test/app",
        name: "plain",
        value: "v",
        domain: undefined,
        path: "/app",
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: "lax",
      },
    ]);
  });

  it("keeps __Host- cookies host-only", () => {
    const file = encodeBinaryCookies([
      { domain: "example.test", name: "__Host-id", path: "/", value: "v", flags: 0x1, expiry: 0 },
    ]);
    expect(parseBinaryCookies(file)[0]).toMatchObject({
      url: "https://example.test/",
      name: "__Host-id",
      domain: undefined,
    });
  });

  it("brackets IPv6 hosts in the cookie URL", () => {
    const file = encodeBinaryCookies([
      { domain: "::1", name: "local", path: "/", value: "v", flags: 0, expiry: 0 },
    ]);
    expect(parseBinaryCookies(file)[0]).toMatchObject({ url: "http://[::1]/", domain: undefined });
  });

  it("reads cookies spread across multiple pages", () => {
    const jar = encodeSafariJar([
      encodeSafariPage([one("a.test", "one")]),
      encodeSafariPage([one("b.test", "two")]),
    ]);
    expect(parseBinaryCookies(jar).map((cookie) => cookie.name)).toEqual(["one", "two"]);
  });

  it("rejects a page that runs past the end of the file", () => {
    // `Buffer.subarray` clamps rather than throwing, so an overlong first page
    // would swallow the second one's bytes.
    const first = encodeSafariPage([one("a.test", "one")]);
    const second = encodeSafariPage([one("b.test", "two")]);
    const jar = encodeSafariJar([first, second]);
    jar.writeUInt32BE(first.length + second.length + 32, 8);
    expect(() => parseBinaryCookies(jar)).toThrow(CookieReadError);
  });

  it("rejects a record whose declared size runs past its page", () => {
    const corrupt = encodeBinaryCookies([
      { domain: "a.test", name: "n", path: "/", value: "v", expiry: 1_000, flags: 0 },
    ]);
    corrupt.writeUInt32LE(0xffff, PAGE_START + corrupt.readUInt32LE(PAGE_START + 8));
    expect(() => parseBinaryCookies(corrupt)).toThrow(CookieReadError);
  });

  it("rejects records truncated inside the 56-byte header", () => {
    const valid = encodeSafariJar([encodeSafariPage([one("a.test", "n")])]);
    const recordStart = PAGE_START + valid.readUInt32LE(PAGE_START + 8);
    for (let size = 48; size < 56; size += 1) {
      const corrupt = Buffer.from(valid);
      corrupt.writeUInt32LE(size, recordStart);
      expect(() => parseBinaryCookies(corrupt), `record size ${size}`).toThrow(CookieReadError);
    }
  });

  it("rejects record offsets that point into the page header or an earlier record", () => {
    const valid = encodeSafariJar([encodeSafariPage([one("a.test", "n"), one("b.test", "m")])]);
    const firstRecord = valid.readUInt32LE(PAGE_START + 8);

    const intoTable = Buffer.from(valid);
    intoTable.writeUInt32LE(4, PAGE_START + 12);
    expect(() => parseBinaryCookies(intoTable)).toThrow(CookieReadError);

    const overlapping = Buffer.from(valid);
    overlapping.writeUInt32LE(firstRecord, PAGE_START + 12);
    expect(() => parseBinaryCookies(overlapping)).toThrow(CookieReadError);

    expect(parseBinaryCookies(valid)).toHaveLength(2);
  });

  it("rejects string offsets that point into the record header", () => {
    const valid = encodeSafariJar([encodeSafariPage([one("a.test", "n")])]);
    const recordStart = PAGE_START + valid.readUInt32LE(PAGE_START + 8);
    for (const offsetField of [16, 20, 24, 28]) {
      const corrupt = Buffer.from(valid);
      corrupt.writeUInt32LE(55, recordStart + offsetField);
      expect(() => parseBinaryCookies(corrupt), `offset field ${offsetField}`).toThrow(
        CookieReadError,
      );
    }
  });

  it("accepts the checksum and property-list trailer Safari writes", () => {
    const file = encodeSafariJar([encodeSafariPage([one("a.test", "c")])]);
    const plist = Buffer.from("bplist00 stub");
    const plistLength = Buffer.alloc(4);
    plistLength.writeUInt32BE(plist.length, 0);
    expect(parseBinaryCookies(Buffer.concat([file, Buffer.alloc(8)]))).toHaveLength(1);
    expect(
      parseBinaryCookies(Buffer.concat([file, Buffer.alloc(8), plistLength, plist])),
    ).toHaveLength(1);
  });

  it("rejects a jar whose page table stops short of its contents", () => {
    const first = encodeSafariJar([encodeSafariPage([one("a.test", "c")])]);
    const extraPage = encodeSafariPage([one("b.test", "d")]);
    expect(() => parseBinaryCookies(Buffer.concat([first, extraPage]))).toThrow(CookieReadError);
    const badLength = Buffer.alloc(4);
    badLength.writeUInt32BE(99, 0);
    expect(() =>
      parseBinaryCookies(Buffer.concat([first, Buffer.alloc(8), badLength, Buffer.from("x")])),
    ).toThrow(CookieReadError);
  });

  it("rejects a file that is not binarycookies", () => {
    expect(() => parseBinaryCookies(Buffer.from("not a cookie jar"))).toThrow(CookieReadError);
  });
});

describe("readSafariCookies", () => {
  function jar(contents: Buffer | string): string {
    const directory = tempDirectory("jhin-safari-");
    cleanups.push(directory.remove);
    const file = Path.join(directory.path, "Cookies.binarycookies");
    Fs.writeFileSync(file, contents);
    return file;
  }

  it("reads a jar from disk", async () => {
    const file = jar(encodeSafariJar([encodeSafariPage([one("a.test", "n")])]));
    expect((await readSafariCookies(file)).map((cookie) => cookie.name)).toEqual(["n"]);
  });

  it("reports a malformed jar as a read failure with the parser's cause", async () => {
    const error = await readSafariCookies(jar("not a cookie jar")).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ reason: "readFailed" });
    expect((error as Error).cause).toBeInstanceOf(CookieReadError);
  });

  it("reports a missing jar as a plain read failure", async () => {
    await expect(readSafariCookies("/nonexistent/Cookies.binarycookies")).rejects.toMatchObject({
      reason: "readFailed",
    });
  });

  it("does not read a readable or missing jar as denied", async () => {
    expect(await safariAccessDenied(jar("x"))).toBe(false);
    expect(await safariAccessDenied("/nonexistent/Cookies.binarycookies")).toBe(false);
  });
});

describe("isPermissionDenied", () => {
  it("treats TCC's EPERM as a missing Full Disk Access grant, and nothing else", () => {
    expect(isPermissionDenied(Object.assign(new Error("denied"), { code: "EPERM" }))).toBe(true);
    // EACCES is an ordinary permission failure Full Disk Access cannot fix.
    expect(isPermissionDenied(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isPermissionDenied(new Error("other"))).toBe(false);
  });
});
