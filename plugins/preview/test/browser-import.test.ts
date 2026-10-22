// Ported in part from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/BrowserImport.test.ts. docs/plans/preview.md, D1204.
import * as Fs from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  createBrowserImport,
  toPlaywrightCookie,
  writeCookies,
} from "../src/browser-import/browser-import.ts";
import type { ImportedCookie } from "../src/browser-import/cookie-database.ts";
import { Chromium } from "../src/chromium.ts";
import { fakeHost, tempDirectory, writeFirefoxCookieDatabase } from "./browser-import-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A Linux machine whose only browser is a Firefox profile with these cookies. */
function machineWithFirefox(rows: Parameters<typeof writeFirefoxCookieDatabase>[1]) {
  const home = tempDirectory("jhin-import-home-");
  cleanups.push(home.remove);
  const root = Path.join(home.path, ".mozilla", "firefox");
  Fs.mkdirSync(root, { recursive: true });
  Fs.writeFileSync(
    Path.join(root, "profiles.ini"),
    "[Profile0]\nName=Personal\nIsRelative=1\nPath=abcd.default-release\n",
  );
  writeFirefoxCookieDatabase(Path.join(root, "abcd.default-release", "cookies.sqlite"), rows, 16);
  return fakeHost({ platform: "linux", home: home.path });
}

const cookie = (fields: Partial<ImportedCookie>): ImportedCookie => ({
  url: "https://example.test/",
  name: "n",
  value: "v",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: false,
  expirationDate: undefined,
  sameSite: "lax",
  ...fields,
});

describe("readCookies failing while the source is resolved", () => {
  it("answers PREVIEW_IMPORT_FAILED with a reason, not the raw error", async () => {
    const machine = machineWithFirefox([]);
    const browserImport = createBrowserImport({
      ...machine,
      addresses: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    await expect(
      browserImport.readCookies({
        sourceId: "firefox",
        sourceProfileDirectory: "abcd.default-release",
      }),
    ).rejects.toMatchObject({
      code: "PREVIEW_IMPORT_FAILED",
      details: { reason: "readFailed", sourceId: "firefox" },
    });
  });
});

describe("listSources and readCookies", () => {
  it("lists the machine's browsers and reads only a profile the source reported", async () => {
    const host = machineWithFirefox([
      {
        host: "example.test",
        name: "session",
        value: "abc",
        path: "/",
        expiry: 0,
        isSecure: 0,
        isHttpOnly: 0,
        sameSite: 1,
      },
    ]);
    const browserImport = createBrowserImport(host);
    const sources = await browserImport.listSources();
    expect(sources.find((source) => source.id === "firefox")).toEqual({
      id: "firefox",
      name: "Firefox",
      profiles: [{ directory: "abcd.default-release", name: "Personal", cookieCount: 1 }],
    });
    expect(sources.find((source) => source.id === "chrome")?.unavailable).toBe("notInstalled");
    expect(sources.find((source) => source.id === "safari")?.unavailable).toBe(
      "unsupportedPlatform",
    );

    const read = await browserImport.readCookies({
      sourceId: "firefox",
      sourceProfileDirectory: "abcd.default-release",
    });
    expect(read.cookies.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "session", value: "abc" },
    ]);
    // A folder the source never reported is refused, however it is spelled.
    for (const sourceProfileDirectory of [
      "../abcd.default-release",
      "abcd.default-release/../abcd.default-release",
      Path.join(host.env.HOME!, ".mozilla", "firefox", "abcd.default-release"),
    ]) {
      await expect(
        browserImport.readCookies({ sourceId: "firefox", sourceProfileDirectory }),
      ).rejects.toMatchObject({
        code: "PREVIEW_IMPORT_FAILED",
        details: { reason: "unknownSourceProfile", sourceId: "firefox" },
        message: "Importing cookies from firefox failed: unknownSourceProfile.",
      });
    }
    await expect(
      browserImport.readCookies({ sourceId: "chrome", sourceProfileDirectory: "Default" }),
    ).rejects.toMatchObject({ details: { reason: "notInstalled" } });
  });
});

describe("toPlaywrightCookie", () => {
  it("keeps host-only cookies host-only, domain cookies their dot, and the path", () => {
    expect(toPlaywrightCookie(cookie({ name: "__Host-id", url: "https://example.test/" }))).toEqual(
      {
        name: "__Host-id",
        value: "v",
        domain: "example.test",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax",
      },
    );
    expect(
      toPlaywrightCookie(
        cookie({
          domain: ".example.test",
          path: "/app",
          sameSite: "unspecified",
          expirationDate: 1_800_000_000,
        }),
      ),
    ).toMatchObject({ domain: ".example.test", path: "/app", expires: 1_800_000_000 });
    expect(toPlaywrightCookie(cookie({ sameSite: "unspecified" }))).not.toHaveProperty("sameSite");
    expect(toPlaywrightCookie(cookie({ sameSite: "no_restriction" })).sameSite).toBe("None");
    expect(toPlaywrightCookie(cookie({ url: "http://[::1]/" })).domain).toBe("[::1]");
    expect(toPlaywrightCookie(cookie({ expirationDate: 9e15 })).expires).toBe(253_402_300_799);
  });
});

describe("writeCookies with duplicates and a closed profile", () => {
  /** A jar keyed as Chromium's: one cookie per name, domain and path. */
  function jarContext() {
    const jar = new Map<string, ReturnType<typeof toPlaywrightCookie>>();
    return {
      jar,
      async addCookies(cookies: ReturnType<typeof toPlaywrightCookie>[]) {
        for (const item of cookies) jar.set(`${item.name}|${item.domain}|${item.path}`, item);
      },
      cookies: async () =>
        [...jar.values()].map((item) => ({
          name: item.name,
          value: item.value,
          domain: item.domain ?? "",
          path: item.path ?? "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax" as const,
        })),
    };
  }

  it("writes one cookie per name, domain and path, the last read winning, and skips none", async () => {
    const context = jarContext();
    const result = await writeCookies(context, {
      cookies: [
        cookie({ name: "session", value: "stale" }),
        cookie({ name: "session", value: "fresh" }),
        cookie({ name: "session", value: "other-path", path: "/app" }),
      ],
      undecryptable: 0,
      undecryptableHosts: [],
    });
    expect(result).toEqual({ imported: 2, skipped: 0, skippedDomains: [] });
    expect([...context.jar.values()].map((item) => item.value)).toEqual(["fresh", "other-path"]);
  });

  it("fails when the profile closed instead of counting every cookie skipped", async () => {
    const closed = {
      ...jarContext(),
      async addCookies() {
        throw new Error(
          "browserContext.addCookies: Target page, context or browser has been closed",
        );
      },
    };
    await expect(
      writeCookies(closed, {
        cookies: [cookie({ name: "a" }), cookie({ name: "b" })],
        undecryptable: 0,
        undecryptableHosts: [],
      }),
    ).rejects.toThrow(/has been closed/);
  });
});

describe("writeCookies", () => {
  it("counts a rejected cookie and its domain as skipped, beside the undecryptable ones", async () => {
    type Written = ReturnType<typeof toPlaywrightCookie>;
    const jar: Written[] = [];
    const context = {
      async addCookies(cookies: Written[]) {
        if (cookies.some((item) => item.name === "rejected")) throw new Error("Invalid cookie");
        // A cookie the browser drops without a word.
        jar.push(...cookies.filter((item) => item.name !== "dropped"));
      },
      cookies: async () =>
        jar.map((item) => ({
          name: item.name,
          value: item.value,
          domain: item.domain ?? "",
          path: item.path ?? "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax" as const,
        })),
    };
    const result = await writeCookies(context, {
      cookies: [
        cookie({ name: "kept" }),
        cookie({ name: "rejected", url: "https://rejected.test/" }),
        cookie({ name: "dropped", url: "https://dropped.test/" }),
        cookie({ name: "also-kept" }),
      ],
      undecryptable: 2,
      undecryptableHosts: ["locked.test"],
    });
    expect(result).toEqual({
      imported: 2,
      skipped: 4,
      skippedDomains: ["locked.test", "rejected.test", "dropped.test"],
    });
    expect(jar.map((item) => item.name)).toEqual(["kept", "also-kept"]);
  });
});

describe("a Firefox profile imported into a profile (D1204, real Chromium)", () => {
  let server: Http.Server;
  let origin = "";
  let host = "";
  const profiles = tempDirectory("jhin-import-profiles-");

  beforeAll(async () => {
    server = Http.createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<title>${request.headers.cookie ?? "no cookie"}</title>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = "127.0.0.1";
    origin = `http://${host}:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    profiles.remove();
  });

  async function titleAt(chromium: Chromium, profileId: string, path: string): Promise<string> {
    const { page } = await chromium.newPage(false, profileId);
    await page.goto(`${origin}${path}`);
    const title = await page.title();
    await page.close();
    return title;
  }

  it("writes the cookies into the profile's folder, and into a running profile at once", async () => {
    // Schema 16 keeps milliseconds; a day from now.
    const expiry = Date.now() + 86_400_000;
    const row = { path: "/", expiry, isSecure: 0, isHttpOnly: 0, sameSite: 1, host };
    const machine = machineWithFirefox([
      { ...row, name: "login", value: "alice" },
      { ...row, name: "scoped", value: "app-only", path: "/app/" },
      // A session cookie lives as long as the profile's browser, as a tab's own.
      { ...row, name: "visit", value: "1", expiry: 0 },
      // SameSite=None without Secure: the profile refuses it, and says so.
      { ...row, name: "refused", value: "x", sameSite: 0 },
    ]);
    const browserImport = createBrowserImport(machine);
    const read = await browserImport.readCookies({
      sourceId: "firefox",
      sourceProfileDirectory: "abcd.default-release",
    });

    // Nothing runs the profile: its context starts for the import, as for a first tab.
    const first = new Chromium({ profilesDir: profiles.path });
    const result = await first.withProfile("work", (context) => writeCookies(context, read));
    expect(result).toEqual({ imported: 3, skipped: 1, skippedDomains: [host] });
    expect(await titleAt(first, "work", "/")).toBe("login=alice; visit=1");
    // The browser closes with its last tab: what lasts is in the profile's folder.
    await first.close();

    const second = new Chromium({ profilesDir: profiles.path });
    expect(await titleAt(second, "work", "/")).toBe("login=alice");
    expect(await titleAt(second, "work", "/app/page")).toBe("scoped=app-only; login=alice");
    expect(await titleAt(second, "default", "/")).toBe("no cookie");

    // A profile a tab runs takes the cookies into its live context.
    const { page } = await second.newPage(false, "home");
    await second.withProfile("home", (context) => writeCookies(context, read));
    await page.goto(`${origin}/`);
    expect(await page.title()).toBe("login=alice; visit=1");
    await second.close();
  });

  it("counts host-only, __Host- and domain cookies the profile holds as imported", async () => {
    const chromium = new Chromium({ profilesDir: profiles.path });
    try {
      const result = await chromium.withProfile("scopes", async (context) => {
        const written = await writeCookies(context, {
          cookies: [
            cookie({ name: "plain", url: `http://${host}/`, secure: false }),
            cookie({ name: "__Host-id", url: `https://${host}/`, secure: true, path: "/" }),
            cookie({ name: "wide", url: "https://example.test/", domain: ".example.test" }),
          ],
          undecryptable: 0,
          undecryptableHosts: [],
        });
        const held = await context.cookies();
        return { written, held };
      });
      expect(result.written).toEqual({ imported: 3, skipped: 0, skippedDomains: [] });
      // Host-only stays host-only: the bare host, no leading dot.
      expect(result.held.find((item) => item.name === "__Host-id")?.domain).toBe(host);
      expect(result.held.find((item) => item.name === "wide")?.domain).toBe(".example.test");
    } finally {
      await chromium.close();
    }
  });
});
