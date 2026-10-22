// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/FirefoxCookies.test.ts. docs/plans/preview.md, D1204.
import * as Fs from "node:fs";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readFirefoxCookies } from "../src/browser-import/firefox-cookies.ts";
import { parseFirefoxProfiles } from "../src/browser-import/sources.ts";
import {
  tempDirectory,
  writeFirefoxCookieDatabase,
  type FirefoxRow,
} from "./browser-import-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function database(rows: ReadonlyArray<FirefoxRow>, schemaVersion?: number): string {
  const directory = tempDirectory("jhin-firefox-test-");
  cleanups.push(directory.remove);
  return writeFirefoxCookieDatabase(
    Path.join(directory.path, "cookies.sqlite"),
    rows,
    schemaVersion,
  );
}

const row = {
  host: "example.test",
  name: "c",
  value: "v",
  path: "/",
  expiry: 0,
  isSecure: 0,
  isHttpOnly: 0,
};

describe("readFirefoxCookies", () => {
  it("converts millisecond expiries from schema 16 and newer", () => {
    // Firefox 129 (schema 16) moved `expiry` to milliseconds; older profiles still
    // hold seconds. Both must land as seconds.
    const cookie = { ...row, expiry: 1_800_000_000_000, sameSite: 0 };
    expect(readFirefoxCookies(database([cookie], 16))[0]?.expirationDate).toBe(1_800_000_000);
    expect(
      readFirefoxCookies(database([{ ...cookie, expiry: 1_800_000_000 }], 15))[0]?.expirationDate,
    ).toBe(1_800_000_000);
  });

  it("maps moz_cookies onto the cookie shape a profile takes", () => {
    const cookies = readFirefoxCookies(
      database([
        {
          host: ".github.com",
          name: "session",
          value: "abc",
          path: "/",
          expiry: 1_800_000_000,
          isSecure: 1,
          isHttpOnly: 1,
          sameSite: 1,
        },
        { ...row, name: "plain", path: "/app", sameSite: 0 },
      ]),
    );
    expect(cookies).toEqual([
      {
        url: "https://github.com/",
        name: "session",
        value: "abc",
        domain: ".github.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: 1_800_000_000,
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
        sameSite: "no_restriction",
      },
    ]);
  });

  it("keeps an unset SameSite unspecified instead of widening it to none", () => {
    // nsICookie::SAMESITE_UNSET is 256: no SameSite attribute, not an explicit None (0).
    const cookies = readFirefoxCookies(
      database([
        { ...row, name: "unset", sameSite: 256 },
        { ...row, name: "none", sameSite: 0 },
      ]),
    );
    expect(cookies.map(({ name, sameSite }) => ({ name, sameSite }))).toEqual([
      { name: "unset", sameSite: "unspecified" },
      { name: "none", sameSite: "no_restriction" },
    ]);
  });

  it("imports rows whose SameSite was never written", () => {
    // Schema 9 added `sameSite` without a default, so older rows hold NULL.
    const cookies = readFirefoxCookies(
      database(
        [
          { ...row, name: "legacy", sameSite: null },
          { ...row, name: "strict", sameSite: 2 },
        ],
        9,
      ),
    );
    expect(cookies.map(({ name, sameSite }) => ({ name, sameSite }))).toEqual([
      { name: "legacy", sameSite: "unspecified" },
      { name: "strict", sameSite: "strict" },
    ]);
  });

  it("applies the schema-15 rawSameSite rule to older databases", () => {
    const cookies = readFirefoxCookies(
      database(
        [
          { ...row, name: "defaulted", sameSite: 1, rawSameSite: 0 },
          { ...row, name: "declared", sameSite: 1, rawSameSite: 1 },
          { ...row, name: "none", sameSite: 0, rawSameSite: 0 },
        ],
        14,
      ),
    );
    expect(cookies.map(({ name, sameSite }) => ({ name, sameSite }))).toEqual([
      { name: "defaulted", sameSite: "unspecified" },
      { name: "declared", sameSite: "lax" },
      { name: "none", sameSite: "no_restriction" },
    ]);
  });

  it("imports only the default container", () => {
    const cookie = {
      host: "mail.test",
      name: "session",
      path: "/",
      expiry: 1_800_000_000,
      isSecure: 1,
      isHttpOnly: 0,
      sameSite: 1,
    };
    const cookies = readFirefoxCookies(
      database([
        { ...cookie, value: "default-container" },
        // Same host, name and path: Firefox keeps them apart by container, a profile cannot.
        { ...cookie, value: "work-container", originAttributes: "^userContextId=2" },
        {
          ...cookie,
          name: "private",
          value: "private-window",
          originAttributes: "^privateBrowsingId=1",
        },
      ]),
    );
    expect(cookies.map((item) => item.value)).toEqual(["default-container"]);
  });

  it("reads without mutating the source database", () => {
    const file = database([{ ...row, expiry: 1_800_000_000, isSecure: 1, sameSite: 2 }]);
    const before = Fs.statSync(file);
    readFirefoxCookies(file);
    const after = Fs.statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it("reports an unreadable database as a read failure", () => {
    const directory = tempDirectory("jhin-firefox-test-");
    cleanups.push(directory.remove);
    const file = Path.join(directory.path, "cookies.sqlite");
    Fs.writeFileSync(file, "not a database");
    expect(() => readFirefoxCookies(file)).toThrow(
      expect.objectContaining({ reason: "readFailed" }),
    );
  });
});

describe("parseFirefoxProfiles", () => {
  const posix = (ini: string, root = "/home/user/.mozilla/firefox") =>
    parseFirefoxProfiles(ini, Path.posix, root);

  it("reads named profiles and ignores Install sections", () => {
    // `Install*` sections name a default profile but do not describe one.
    expect(
      posix(
        [
          "[Install4F96D1932A9F858E]",
          "Default=Profiles/abcd1234.default-release",
          "Locked=1",
          "",
          "[Profile0]",
          "Name=default-release",
          "IsRelative=1",
          "Path=Profiles/abcd1234.default-release",
          "",
          "[Profile1]",
          "Name=Work",
          "IsRelative=0",
          "Path=/Volumes/External/firefox-work",
          "",
          "[General]",
          "StartWithLastProfile=1",
        ].join("\n"),
      ),
    ).toEqual([
      { directory: "Profiles/abcd1234.default-release", name: "default-release" },
      { directory: "/Volumes/External/firefox-work", name: "Work" },
    ]);
  });

  it("falls back to the path when a profile has no name", () => {
    expect(posix(["[Profile0]", "Path=Profiles/x.default"].join("\n"))).toEqual([
      { directory: "Profiles/x.default", name: "Profiles/x.default" },
    ]);
  });

  it.each([
    { platform: "Linux", root: "/home/user/.mozilla/firefox" },
    { platform: "macOS", root: "/Users/user/Library/Application Support/Firefox" },
  ])("validates relative and absolute $platform profile paths", ({ root }) => {
    expect(
      posix(
        [
          "[Profile0]",
          "Name=Relative",
          "IsRelative=1",
          "Path=Profiles/relative.default",
          "[Profile1]",
          "Name=Custom",
          "IsRelative=0",
          "Path=/mnt/custom/firefox-profile",
          "[Profile2]",
          "IsRelative=1",
          "Path=../../escape",
          "[Profile3]",
          "IsRelative=1",
          "Path=/absolute-marked-relative",
          "[Profile4]",
          "IsRelative=0",
          "Path=relative-marked-absolute",
          "[Profile5]",
          "IsRelative=1",
          "Path=Profiles/nul\u0000escape",
          "[Profile6]",
          "IsRelative=yes",
          "Path=Profiles/bad-flag",
        ].join("\n"),
        root,
      ),
    ).toEqual([
      { directory: "Profiles/relative.default", name: "Relative" },
      { directory: "/mnt/custom/firefox-profile", name: "Custom" },
    ]);
  });

  it("uses Windows path rules for relative and absolute profiles", () => {
    expect(
      parseFirefoxProfiles(
        [
          "[Profile0]",
          "Name=Relative",
          "IsRelative=1",
          "Path=Profiles\\relative.default",
          "[Profile1]",
          "Name=Custom",
          "IsRelative=0",
          "Path=D:\\Firefox Profiles\\Work",
          "[Profile2]",
          "IsRelative=1",
          "Path=..\\..\\escape",
          "[Profile3]",
          "IsRelative=1",
          "Path=D:\\absolute-marked-relative",
          "[Profile4]",
          "IsRelative=0",
          "Path=relative-marked-absolute",
        ].join("\r\n"),
        Path.win32,
        "C:\\Users\\user\\Firefox",
      ),
    ).toEqual([
      { directory: "Profiles\\relative.default", name: "Relative" },
      { directory: "D:\\Firefox Profiles\\Work", name: "Custom" },
    ]);
  });
});
