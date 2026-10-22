// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/Sources.test.ts. docs/plans/preview.md, D1204.
import * as Fs from "node:fs";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { processIsAlive } from "../src/browser-import/host.ts";
import {
  BROWSER_IMPORT_SOURCES,
  chromiumSingletonLockIsHeld,
  cookieDatabaseCandidatePaths,
  firefoxSymlinkLockIsHeld,
  isSourceInstalled,
  isSourceRunning,
  isWindowsLockHeldError,
  listSourceProfiles,
  posixLockIsHeld,
  resolveCookieDatabase,
  sourcePathContext,
  windowsChromiumCookiesAreHeld,
} from "../src/browser-import/sources.ts";
import { fakeHost, ran, tempDirectory } from "./browser-import-fixtures.ts";

const source = (id: string) => BROWSER_IMPORT_SOURCES.find((candidate) => candidate.id === id)!;
const helium = source("helium");
const firefox = source("firefox");
const safari = source("safari");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A home of the test's on `platform`; the host answers no program. */
function home(platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}) {
  const directory = tempDirectory("jhin-sources-");
  cleanups.push(directory.remove);
  const host = fakeHost({ platform, home: directory.path, env });
  return { home: directory.path, host, context: sourcePathContext(host) };
}

function write(file: string, contents: string | Buffer = "db"): void {
  Fs.mkdirSync(Path.dirname(file), { recursive: true });
  Fs.writeFileSync(file, contents);
}

function writeCookieDatabase(file: string, count: number): void {
  Fs.mkdirSync(Path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("create table cookies (host_key text, name text)");
  const insert = database.prepare("insert into cookies (host_key, name) values (?, ?)");
  for (let index = 0; index < count; index += 1) insert.run("example.test", `c${index}`);
  database.close();
}

function writeFirefoxCount(file: string, defaultContainer: number, containers: number): void {
  Fs.mkdirSync(Path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("create table moz_cookies (originAttributes text not null)");
  const insert = database.prepare("insert into moz_cookies (originAttributes) values (?)");
  for (let index = 0; index < defaultContainer; index += 1) insert.run("");
  for (let index = 0; index < containers; index += 1) insert.run("^userContextId=2");
  database.close();
}

describe("the sources", () => {
  it("are T3's browsers, with each Linux fork's libsecret application", () => {
    expect(BROWSER_IMPORT_SOURCES.map((definition) => definition.id)).toEqual([
      "chrome",
      "edge",
      "brave",
      "vivaldi",
      "opera",
      "arc",
      "helium",
      "safari",
      "firefox",
    ]);
    expect(
      Object.fromEntries(
        BROWSER_IMPORT_SOURCES.filter((definition) => definition.platforms.includes("linux")).map(
          (definition) => [definition.id, definition.linuxSecretApplication],
        ),
      ),
    ).toEqual({
      chrome: "chrome",
      edge: "msedge",
      brave: "brave",
      vivaldi: "vivaldi",
      opera: "opera",
      helium: "chromium",
      firefox: undefined,
    });
  });

  it("resolve their folders per platform, with only Helium among Chromium forks on Windows", () => {
    const linux = sourcePathContext(fakeHost({ platform: "linux", home: "/home/u" }));
    expect(source("chrome").userDataDirectory(linux)).toBe("/home/u/.config/google-chrome");
    expect(source("brave").userDataDirectory(linux)).toBe(
      "/home/u/.config/BraveSoftware/Brave-Browser",
    );
    expect(source("arc").userDataDirectory(linux)).toBeUndefined();
    expect(firefox.userDataDirectory(linux)).toBe("/home/u/.mozilla/firefox");
    expect(safari.userDataDirectory(linux)).toBeUndefined();

    const mac = sourcePathContext(fakeHost({ platform: "darwin", home: "/Users/u" }));
    expect(source("arc").userDataDirectory(mac)).toBe(
      "/Users/u/Library/Application Support/Arc/User Data",
    );
    expect(safari.userDataDirectory(mac)).toBe(
      "/Users/u/Library/Containers/com.apple.Safari/Data/Library/Cookies",
    );

    const windows = sourcePathContext(
      fakeHost({
        platform: "win32",
        home: "C:\\Users\\u",
        env: {
          LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
          APPDATA: "C:\\Users\\u\\AppData\\Roaming",
        },
      }),
    );
    expect(helium.userDataDirectory(windows)).toBe(
      "C:\\Users\\u\\AppData\\Local\\imput\\Helium\\User Data",
    );
    expect(firefox.userDataDirectory(windows)).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\Mozilla\\Firefox",
    );
    for (const definition of BROWSER_IMPORT_SOURCES) {
      if (definition.engine === "chromium" && definition.id !== "helium") {
        expect(definition.platforms).not.toContain("win32");
      }
    }
  });
});

describe("cookieDatabaseCandidatePaths", () => {
  it("prefers Network/Cookies, falls back to the legacy Cookies, and gives Firefox cookies.sqlite", () => {
    const { context } = home("linux");
    const root = helium.userDataDirectory(context)!;
    expect(cookieDatabaseCandidatePaths(helium, context, "Default")).toEqual([
      Path.join(root, "Default", "Network", "Cookies"),
      Path.join(root, "Default", "Cookies"),
    ]);
    expect(cookieDatabaseCandidatePaths(firefox, context, "abcd.default")).toEqual([
      Path.join(firefox.userDataDirectory(context)!, "abcd.default", "cookies.sqlite"),
    ]);
  });

  it("resolves the live Network/ jar over a leftover root Cookies, and skips a folder named Cookies", async () => {
    const { context } = home();
    const root = helium.userDataDirectory(context)!;
    write(Path.join(root, "Default", "Cookies"));
    write(Path.join(root, "Default", "Network", "Cookies"));
    expect(await resolveCookieDatabase(helium, context, "Default")).toBe(
      Path.join(root, "Default", "Network", "Cookies"),
    );
    Fs.mkdirSync(Path.join(root, "Other", "Network", "Cookies"), { recursive: true });
    write(Path.join(root, "Other", "Cookies"));
    expect(await resolveCookieDatabase(helium, context, "Other")).toBe(
      Path.join(root, "Other", "Cookies"),
    );
  });
});

describe("listSourceProfiles", () => {
  it("reads the profile names the browser shows, with their cookie counts", async () => {
    const { context } = home();
    const root = helium.userDataDirectory(context)!;
    writeCookieDatabase(Path.join(root, "Default", "Cookies"), 3);
    write(
      Path.join(root, "Local State"),
      `{"profile":{"info_cache":{"Default":{"name":"You"},"Profile 2":{"name":"  "}}}}`,
    );
    expect(await listSourceProfiles(helium, context)).toEqual([
      { directory: "Default", name: "You", cookieCount: 3 },
      { directory: "Profile 2", name: "Profile 2" },
    ]);
  });

  it("discovers profiles by their cookie database when Local State is absent or malformed", async () => {
    const { context } = home();
    const root = helium.userDataDirectory(context)!;
    write(Path.join(root, "Profile 1", "Cookies"));
    Fs.mkdirSync(Path.join(root, "NativeMessagingHosts"), { recursive: true });
    Fs.mkdirSync(Path.join(root, "Broken", "Cookies"), { recursive: true });
    expect(await listSourceProfiles(helium, context)).toEqual([
      { directory: "Profile 1", name: "Profile 1" },
    ]);
    write(Path.join(root, "Local State"), "{not-json");
    expect(await listSourceProfiles(helium, context)).toEqual([
      { directory: "Profile 1", name: "Profile 1" },
    ]);
  });

  it("drops profile folders that are not a single plain segment", async () => {
    const { context } = home();
    const root = helium.userDataDirectory(context)!;
    write(Path.join(root, "Default", "Cookies"));
    write(
      Path.join(root, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            "..": { name: "Up" },
            "../outside": { name: "Escape" },
            "nested/profile": { name: "Nested" },
            "back\\slash": { name: "Back" },
            ".": { name: "Here" },
            Default: { name: "Personal" },
          },
        },
      }),
    );
    expect(await listSourceProfiles(helium, context)).toEqual([
      { directory: "Default", name: "Personal" },
    ]);
  });

  it("reports nothing when no folder holds a cookie database", async () => {
    const { context } = home();
    expect(await listSourceProfiles(helium, context)).toEqual([]);
  });

  it("drops Firefox profiles without a cookie database, and counts only the default container", async () => {
    const { context } = home();
    const root = firefox.userDataDirectory(context)!;
    write(
      Path.join(root, "profiles.ini"),
      "[Profile0]\nName=original\nIsRelative=1\nPath=Profiles/abcd.default-release\nDefault=1\n\n" +
        "[Profile1]\nName=empty\nIsRelative=1\nPath=Profiles/wxyz.empty\n",
    );
    writeFirefoxCount(Path.join(root, "Profiles", "abcd.default-release", "cookies.sqlite"), 2, 5);
    Fs.mkdirSync(Path.join(root, "Profiles", "wxyz.empty"), { recursive: true });
    expect(await listSourceProfiles(firefox, context)).toEqual([
      {
        directory: Path.join("Profiles", "abcd.default-release"),
        name: "original",
        cookieCount: 2,
      },
    ]);
  });

  it("scans Profiles/ when profiles.ini declares only profiles without cookies", async () => {
    const { context } = home();
    const root = firefox.userDataDirectory(context)!;
    write(Path.join(root, "profiles.ini"), "[Profile0]\nName=stale\nPath=Profiles/stale.default\n");
    write(Path.join(root, "Profiles", "filled.default", "cookies.sqlite"));
    Fs.mkdirSync(Path.join(root, "Profiles", "empty.default"), { recursive: true });
    expect(await listSourceProfiles(firefox, context)).toEqual([
      { directory: Path.join("Profiles", "filled.default"), name: "filled.default" },
    ]);
  });

  it("finds Linux Firefox's Snap profiles by absolute folder, distinct from native ones", async () => {
    const { home: homeDirectory, context } = home("linux");
    const native = Path.join(homeDirectory, ".mozilla", "firefox");
    const snap = Path.join(homeDirectory, "snap", "firefox", "common", ".mozilla", "firefox");
    for (const root of [native, snap]) {
      writeFirefoxCount(Path.join(root, "abcd.default", "cookies.sqlite"), 1, 0);
      write(
        Path.join(root, "profiles.ini"),
        "[Profile0]\nName=Personal\nIsRelative=1\nPath=abcd.default\n" +
          `[Profile1]\nName=Shared\nIsRelative=0\nPath=${snap}/abcd.default\n`,
      );
    }
    const profiles = await listSourceProfiles(firefox, context);
    expect(profiles.map((profile) => profile.directory)).toEqual([
      "abcd.default",
      Path.join(snap, "abcd.default"),
    ]);
    expect(await resolveCookieDatabase(firefox, context, Path.join(snap, "abcd.default"))).toBe(
      Path.join(snap, "abcd.default", "cookies.sqlite"),
    );
  });

  it("lists Safari's named profiles from its metadata, and its default jar", async () => {
    const { home: homeDirectory, context } = home("darwin");
    const library = Path.join(
      homeDirectory,
      "Library",
      "Containers",
      "com.apple.Safari",
      "Data",
      "Library",
    );
    write(Path.join(library, "Cookies", "Cookies.binarycookies"));
    Fs.mkdirSync(Path.join(library, "Safari"), { recursive: true });
    const metadata = new DatabaseSync(Path.join(library, "Safari", "SafariTabs.db"));
    metadata.exec(
      "create table bookmarks (title text, external_uuid text, parent integer, type integer, subtype integer, deleted integer, order_index integer)",
    );
    const insert = metadata.prepare("insert into bookmarks values (?, ?, 0, 1, 2, ?, ?)");
    insert.run("Personal", "DefaultProfile", 0, 0);
    insert.run("Work", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", 0, 1);
    insert.run("Gone", "11111111-2222-3333-4444-555555555555", 1, 2);
    insert.run("Bad", "../escape", 0, 3);
    metadata.close();
    expect(await listSourceProfiles(safari, context)).toEqual([
      { directory: ".", name: "Personal" },
      {
        directory: Path.join(
          library,
          "WebKit",
          "WebsiteDataStore",
          "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          "Cookies",
        ),
        name: "Work",
      },
    ]);
  });
});

describe("isSourceInstalled", () => {
  it("ignores a user-data folder that holds no cookie database", async () => {
    const { context } = home();
    const root = helium.userDataDirectory(context)!;
    // Native messaging hosts create an empty folder for every Chromium fork they know.
    Fs.mkdirSync(Path.join(root, "NativeMessagingHosts"), { recursive: true });
    expect(await isSourceInstalled(helium, context)).toBe(false);
    write(Path.join(root, "Default", "Network", "Cookies"));
    expect(await isSourceInstalled(helium, context)).toBe(true);
  });
});

describe("isSourceRunning", () => {
  it("reads Chromium's dangling SingletonLock as running unless its pid of this host is dead", async () => {
    const directory = tempDirectory("jhin-sources-");
    cleanups.push(directory.remove);
    let alive = true;
    const host = fakeHost({
      platform: "linux",
      home: directory.path,
      hostname: "lock-owner",
      alive: () => alive,
    });
    const context = sourcePathContext(host);
    const root = helium.userDataDirectory(context)!;
    write(Path.join(root, "Default", "Cookies"));
    expect(await isSourceRunning(host, helium, context)).toBe(false);
    // The lock points at `<host>-<pid>`, a target that never exists on disk.
    Fs.symlinkSync("lock-owner-4242", Path.join(root, "SingletonLock"));
    expect(await isSourceRunning(host, helium, context)).toBe(true);
    alive = false;
    expect(await isSourceRunning(host, helium, context)).toBe(false);
    Fs.rmSync(Path.join(root, "SingletonLock"));
    Fs.symlinkSync("another-host-4242", Path.join(root, "SingletonLock"));
    expect(await isSourceRunning(host, helium, context)).toBe(true);
  });

  it("reads a Firefox lock symlink's pid to tell live from crashed, ignoring a stale .parentlock", async () => {
    const directory = tempDirectory("jhin-sources-");
    cleanups.push(directory.remove);
    let alive = true;
    const host = fakeHost({
      platform: "linux",
      home: directory.path,
      alive: () => alive,
      // The fcntl probe answers "free": the .parentlock left on disk is nobody's.
      run: () => ran(0, "free\n"),
    });
    const context = sourcePathContext(host);
    const profile = Path.join(firefox.userDataDirectory(context)!, "abcd.default");
    write(Path.join(profile, "cookies.sqlite"));
    write(Path.join(profile, ".parentlock"), "");
    expect(await isSourceRunning(host, firefox, context)).toBe(false);
    Fs.symlinkSync("127.0.0.1:+4242", Path.join(profile, "lock"));
    expect(await isSourceRunning(host, firefox, context)).toBe(true);
    alive = false;
    expect(await isSourceRunning(host, firefox, context)).toBe(false);
  });

  it("uses the held cookie database as Chromium's Windows running signal", async () => {
    // Windows' rules over this machine's paths, so the profile can live in a temp folder.
    const { home: homeDirectory, context: windows } = home("win32");
    const context = { ...windows, path: Path.posix, localAppData: homeDirectory };
    const database = Path.join(helium.userDataDirectory(context)!, "Default", "Network", "Cookies");
    writeCookieDatabase(database, 1);
    const probed: string[] = [];
    expect(
      await windowsChromiumCookiesAreHeld(helium, context, async (path) => {
        probed.push(path);
        return true;
      }),
    ).toBe(true);
    expect(probed).toEqual([database]);
  });
});

describe("the lock checks", () => {
  it("chromiumSingletonLockIsHeld probes only a well-formed pid of this host", () => {
    const checked: number[] = [];
    const probe = (pid: number) => {
      checked.push(pid);
      return false;
    };
    expect(chromiumSingletonLockIsHeld("current-host-4321", "current-host", probe)).toBe(false);
    expect(chromiumSingletonLockIsHeld("current-host-4321", "current-host", () => true)).toBe(true);
    expect(chromiumSingletonLockIsHeld("another-host-4321", "current-host", probe)).toBe(true);
    expect(chromiumSingletonLockIsHeld("current-host-no-pid", "current-host", probe)).toBe(true);
    expect(chromiumSingletonLockIsHeld("current-host-0", "current-host", probe)).toBe(true);
    expect(checked).toEqual([4321]);
  });

  it("firefoxSymlinkLockIsHeld trusts a pid only when its address is one of this machine's", () => {
    const local = new Set(["127.0.1.1"]);
    expect(firefoxSymlinkLockIsHeld("127.0.1.1:+4242", local, () => false)).toBe(false);
    expect(firefoxSymlinkLockIsHeld("127.0.1.1:4242", local, () => true)).toBe(true);
    expect(firefoxSymlinkLockIsHeld("10.0.0.9:4242", local, () => false)).toBe(true);
    expect(firefoxSymlinkLockIsHeld("127.0.1.1:pid", local, () => false)).toBe(true);
    expect(firefoxSymlinkLockIsHeld("no-separator", local, () => false)).toBe(true);
  });

  it("posixLockIsHeld falls back to not held when no interpreter runs the probe", async () => {
    const missing = fakeHost({ home: "/home/u" });
    expect(await posixLockIsHeld(missing, "/x/.parentlock")).toBe(false);
    expect(missing.calls.map((call) => call.command)).toEqual(["/usr/bin/python3", "python3"]);
    const held = fakeHost({ home: "/home/u", run: () => ran(0, "held\n") });
    expect(await posixLockIsHeld(held, "/x/.parentlock")).toBe(true);
  });

  it("Windows sharing violations are held, access denied and missing files are not", () => {
    expect(isWindowsLockHeldError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(true);
    expect(isWindowsLockHeldError(Object.assign(new Error("denied"), { code: "EPERM" }))).toBe(
      false,
    );
    expect(isWindowsLockHeldError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(
      false,
    );
  });

  it("processIsAlive is false only when signal 0 reports a missing process", () => {
    const throwing = (value: unknown) => () => {
      throw value;
    };
    expect(processIsAlive(4321, throwing(Object.assign(new Error("x"), { code: "ESRCH" })))).toBe(
      false,
    );
    expect(processIsAlive(4321, throwing(Object.assign(new Error("x"), { code: "EPERM" })))).toBe(
      true,
    );
    expect(processIsAlive(4321, throwing(undefined))).toBe(true);
    expect(processIsAlive(4321, throwing(null))).toBe(true);
    expect(processIsAlive(4321, () => true)).toBe(true);
  });
});
