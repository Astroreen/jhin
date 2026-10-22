// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/Sources.ts (the browsers, their folders on each
// platform, profile discovery, cookie counts and the running checks). docs/plans/preview.md, D1204.
import * as Fs from "node:fs";
import type * as Path from "node:path";

import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@jhin/preview-api";

import { withDatabase } from "./cookie-database.ts";
import { pathFor, type ImportHost } from "./host.ts";

type BrowserImportEngine = "chromium" | "firefox" | "safari";

export interface BrowserImportPathContext {
  readonly path: Path.PlatformPath;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly appData: string | undefined;
  readonly localAppData: string | undefined;
}

export interface BrowserImportSourceDefinition {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly engine: BrowserImportEngine;
  readonly platforms: ReadonlyArray<NodeJS.Platform>;
  readonly userDataDirectory: (context: BrowserImportPathContext) => string | undefined;
  readonly keychainService?: string;
  readonly keychainAccount?: string;
  readonly linuxSecretApplication?: string;
}

export function sourcePathContext(host: ImportHost): BrowserImportPathContext {
  return {
    path: pathFor(host.platform),
    platform: host.platform,
    home: host.env.HOME ?? host.env.USERPROFILE ?? "",
    appData: host.env.APPDATA,
    localAppData: host.env.LOCALAPPDATA,
  };
}

const macApplicationSupport = (
  context: BrowserImportPathContext,
  ...segments: ReadonlyArray<string>
) => context.path.join(context.home, "Library", "Application Support", ...segments);

const chromiumSource = (input: {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly macSegments: ReadonlyArray<string>;
  readonly linuxSegments?: ReadonlyArray<string>;
  readonly linuxSecretApplication?: string;
  readonly windowsSegments?: ReadonlyArray<string>;
}): BrowserImportSourceDefinition => ({
  id: input.id,
  name: input.name,
  engine: "chromium",
  platforms: [
    "darwin",
    ...(input.linuxSegments ? (["linux"] as const) : []),
    ...(input.windowsSegments ? (["win32"] as const) : []),
  ],
  keychainService: input.keychainService,
  keychainAccount: input.keychainAccount,
  ...(input.linuxSecretApplication === undefined
    ? {}
    : { linuxSecretApplication: input.linuxSecretApplication }),
  userDataDirectory: (context) => {
    if (context.platform === "darwin") return macApplicationSupport(context, ...input.macSegments);
    if (context.platform === "win32") {
      return input.windowsSegments && context.localAppData
        ? context.path.join(context.localAppData, ...input.windowsSegments)
        : undefined;
    }
    return input.linuxSegments
      ? context.path.join(context.home, ".config", ...input.linuxSegments)
      : undefined;
  },
});

export const BROWSER_IMPORT_SOURCES: ReadonlyArray<BrowserImportSourceDefinition> = [
  // No Chromium fork but Helium is importable on Windows: since Chrome 127 their
  // cookies are encrypted to the browser's own identity (App-Bound Encryption),
  // so no other process can read them.
  chromiumSource({
    id: "chrome",
    name: "Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    macSegments: ["Google", "Chrome"],
    linuxSegments: ["google-chrome"],
    linuxSecretApplication: "chrome",
  }),
  chromiumSource({
    id: "edge",
    name: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    macSegments: ["Microsoft Edge"],
    linuxSegments: ["microsoft-edge"],
    linuxSecretApplication: "msedge",
  }),
  chromiumSource({
    id: "brave",
    name: "Brave",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    macSegments: ["BraveSoftware", "Brave-Browser"],
    linuxSegments: ["BraveSoftware", "Brave-Browser"],
    linuxSecretApplication: "brave",
  }),
  chromiumSource({
    id: "vivaldi",
    name: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    keychainAccount: "Vivaldi",
    macSegments: ["Vivaldi"],
    linuxSegments: ["vivaldi"],
    linuxSecretApplication: "vivaldi",
  }),
  chromiumSource({
    id: "opera",
    name: "Opera",
    keychainService: "Opera Safe Storage",
    keychainAccount: "Opera",
    macSegments: ["com.operasoftware.Opera"],
    linuxSegments: ["opera"],
    linuxSecretApplication: "opera",
  }),
  chromiumSource({
    id: "arc",
    name: "Arc",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
    macSegments: ["Arc", "User Data"],
  }),
  chromiumSource({
    id: "helium",
    name: "Helium",
    keychainService: "Helium Storage Key",
    keychainAccount: "Helium",
    macSegments: ["net.imput.helium"],
    linuxSegments: ["net.imput.helium"],
    windowsSegments: ["imput", "Helium", "User Data"],
    // Helium retains Chromium's libsecret application name on Linux.
    linuxSecretApplication: "chromium",
  }),
  {
    id: "safari",
    name: "Safari",
    engine: "safari",
    platforms: ["darwin"],
    userDataDirectory: (context) =>
      context.platform === "darwin"
        ? context.path.join(
            context.home,
            "Library",
            "Containers",
            "com.apple.Safari",
            "Data",
            "Library",
            "Cookies",
          )
        : undefined,
  },
  {
    id: "firefox",
    name: "Firefox",
    engine: "firefox",
    platforms: ["darwin", "win32", "linux"],
    userDataDirectory: (context) => {
      if (context.platform === "darwin") return macApplicationSupport(context, "Firefox");
      if (context.platform === "win32") {
        return context.appData
          ? context.path.join(context.appData, "Mozilla", "Firefox")
          : undefined;
      }
      return context.path.join(context.home, ".mozilla", "firefox");
    },
  },
];

export function cookieDatabaseCandidatePaths(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
): ReadonlyArray<string> {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const profilePath = context.path.isAbsolute(profileDirectory)
    ? profileDirectory
    : context.path.join(root, profileDirectory);
  if (definition.engine === "firefox") return [context.path.join(profilePath, "cookies.sqlite")];
  if (definition.engine === "safari") {
    return [context.path.join(profilePath, "Cookies.binarycookies")];
  }
  // Chromium: pre-96 uses `Cookies`, 96+ uses `Network/Cookies`. An upgrade leaves
  // the legacy file behind, so prefer the current one and fall back.
  return [
    context.path.join(profilePath, "Network", "Cookies"),
    context.path.join(profilePath, "Cookies"),
  ];
}

async function databaseFileExists(path: string): Promise<boolean> {
  try {
    return (await Fs.promises.stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await Fs.promises.readdir(path);
  } catch {
    return [];
  }
}

export async function resolveCookieDatabase(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
): Promise<string | undefined> {
  for (const candidate of cookieDatabaseCandidatePaths(definition, context, profileDirectory)) {
    if (await databaseFileExists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Firefox records its profiles in `profiles.ini`. `Install*` sections point at a
 * default profile but do not describe one, so only `[ProfileN]` blocks count.
 */
export function parseFirefoxProfiles(
  ini: string,
  path: Path.PlatformPath,
  root: string,
): ReadonlyArray<BrowserImportSourceProfile> {
  const profiles: BrowserImportSourceProfile[] = [];
  let current: { name?: string; path?: string; isRelative?: string } | null = null;

  const flush = () => {
    if (current?.path) {
      const candidate = current.path;
      const isRelative = current.isRelative === undefined || current.isRelative === "1";
      const validIsRelative = current.isRelative === undefined || /^[01]$/.test(current.isRelative);
      if (!validIsRelative || candidate.includes("\u0000")) {
        current = null;
        return;
      }

      let directory: string | undefined;
      if (isRelative) {
        if (!path.isAbsolute(candidate)) {
          const resolved = path.resolve(root, candidate);
          const relative = path.relative(root, resolved);
          const escapesRoot =
            relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
          if (!escapesRoot) directory = path.normalize(candidate);
        }
      } else if (path.isAbsolute(candidate)) {
        // Firefox supports profiles on arbitrary custom roots when IsRelative=0.
        // Do not constrain them to the standard Firefox root.
        directory = path.normalize(candidate);
      }

      if (directory !== undefined) {
        profiles.push({ directory, name: current.name?.trim() || directory });
      }
    }
    current = null;
  };

  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      flush();
      current = /^\[Profile\d+\]$/i.test(line) ? {} : null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "name") current.name = value;
    if (key === "path") current.path = value;
    if (key === "isrelative") current.isRelative = value;
  }
  flush();
  return profiles;
}

/** A Chromium profile folder must be one plain segment of the user-data folder. */
const isSafeProfileDirectory = (directory: string): boolean =>
  directory.length > 0 &&
  directory !== "." &&
  directory !== ".." &&
  !/[\\/]/.test(directory) &&
  !directory.includes("\u0000");

/** The profile names of Chromium's `Local State` (`profile.info_cache`), by folder. */
function localStateProfiles(contents: string): Array<[string, string | undefined]> {
  const state = JSON.parse(contents) as { profile?: { info_cache?: unknown } } | null;
  const cache = state?.profile?.info_cache;
  if (cache === undefined) return [];
  if (typeof cache !== "object" || cache === null) throw new Error("Malformed Local State");
  return Object.entries(cache).map(([directory, info]) => {
    if (typeof info !== "object" || info === null) throw new Error("Malformed Local State");
    const name = (info as { name?: unknown }).name;
    if (name !== undefined && typeof name !== "string") throw new Error("Malformed Local State");
    return [directory, name];
  });
}

/**
 * Firefox containers use identities a profile cannot represent, so its count uses
 * the same default-container predicate as the reader.
 */
async function countProfileCookies(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  directory: string,
): Promise<number | undefined> {
  const database = await resolveCookieDatabase(definition, context, directory);
  if (database === undefined || definition.engine === "safari") return undefined;
  try {
    return withDatabase(database, (sqlite) => {
      const row = sqlite
        .prepare(
          definition.engine === "firefox"
            ? "select count(*) as count from moz_cookies where originAttributes = ''"
            : "select count(*) as count from cookies",
        )
        .get();
      return typeof row?.count === "number" ? row.count : undefined;
    });
  } catch {
    return undefined;
  }
}

const withCookieCounts = (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profiles: ReadonlyArray<BrowserImportSourceProfile>,
): Promise<BrowserImportSourceProfile[]> =>
  Promise.all(
    profiles.map(async (profile) => {
      const cookieCount = await countProfileCookies(definition, context, profile.directory);
      return cookieCount === undefined ? profile : { ...profile, cookieCount };
    }),
  );

const isSafariProfileUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

interface SafariProfileRow {
  readonly title: string | null;
  readonly external_uuid: string;
}

async function listSafariProfiles(
  context: BrowserImportPathContext,
  root: string,
): Promise<BrowserImportSourceProfile[]> {
  const library = context.path.dirname(root);
  const metadata = context.path.join(library, "Safari", "SafariTabs.db");
  let declared: SafariProfileRow[] = [];
  try {
    const rows = withDatabase(metadata, (database) =>
      database
        .prepare(
          `select title, external_uuid from bookmarks
           where parent = 0 and type = 1 and subtype = 2 and deleted = 0
           order by order_index`,
        )
        .all(),
    );
    if (
      rows.every(
        (row) =>
          (row.title === null || typeof row.title === "string") &&
          typeof row.external_uuid === "string",
      )
    ) {
      declared = rows as unknown as SafariProfileRow[];
    }
  } catch {
    declared = [];
  }
  const defaultProfile = declared.find((profile) => profile.external_uuid === "DefaultProfile");
  const profiles: BrowserImportSourceProfile[] = [
    {
      directory: ".",
      name: defaultProfile ? defaultProfile.title?.trim() || "Personal" : "Safari",
    },
  ];
  const stores = context.path.join(library, "WebKit", "WebsiteDataStore");
  for (const profile of declared) {
    if (!isSafariProfileUuid(profile.external_uuid)) continue;
    profiles.push({
      directory: context.path.join(stores, profile.external_uuid.toLowerCase(), "Cookies"),
      name: profile.title?.trim() || profile.external_uuid,
    });
  }
  // With readable metadata, deleted profiles left on disk are not resurrected.
  if (declared.length === 0) {
    for (const entry of (await readDirectory(stores)).filter(isSafariProfileUuid).toSorted()) {
      const directory = context.path.join(stores, entry, "Cookies");
      if (await databaseFileExists(context.path.join(directory, "Cookies.binarycookies"))) {
        profiles.push({ directory, name: entry });
      }
    }
  }
  return profiles;
}

async function listSourceProfilesInDirectory(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Promise<ReadonlyArray<BrowserImportSourceProfile>> {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];

  if (definition.engine === "safari") return listSafariProfiles(context, root);

  if (definition.engine === "firefox") {
    let declared: ReadonlyArray<BrowserImportSourceProfile> = [];
    try {
      const ini = await Fs.promises.readFile(context.path.join(root, "profiles.ini"), "utf8");
      declared = parseFirefoxProfiles(ini, context.path, root);
    } catch {
      declared = [];
    }
    // `profiles.ini` also lists profiles the installer created but the user never
    // launched, which hold no cookie database. When none of the declared profiles
    // has one, fall through to the scan rather than returning empty: the cookies
    // may live in a profile it does not mention.
    if (declared.length > 0) {
      const found = await Promise.all(
        declared.map(async (profile) => {
          const results = await Promise.all(
            cookieDatabaseCandidatePaths(definition, context, profile.directory).map(
              databaseFileExists,
            ),
          );
          return results.some(Boolean) ? profile : undefined;
        }),
      );
      const withCookies = found.filter((profile) => profile !== undefined);
      if (withCookies.length > 0) return withCookieCounts(definition, context, withCookies);
    }

    const fallbackDirectory =
      context.platform === "linux" ? root : context.path.join(root, "Profiles");
    const found = await Promise.all(
      (await readDirectory(fallbackDirectory)).map(async (entry) => {
        const directory =
          context.platform === "linux" ? entry : context.path.join("Profiles", entry);
        const database = await resolveCookieDatabase(definition, context, directory);
        return database === undefined ? undefined : { directory, name: entry };
      }),
    );
    return withCookieCounts(
      definition,
      context,
      found.filter((profile) => profile !== undefined),
    );
  }

  let declared: BrowserImportSourceProfile[] = [];
  try {
    const contents = await Fs.promises.readFile(context.path.join(root, "Local State"), "utf8");
    // The keys are folder names from the browser's own metadata file, which
    // anything running as the user can write. Anything but a single plain segment
    // is dropped: `..` or a separator would read a database outside the folder.
    declared = localStateProfiles(contents)
      .filter(([directory]) => isSafeProfileDirectory(directory))
      .map(([directory, name]) => ({ directory, name: name?.trim() || directory }));
  } catch {
    declared = [];
  }
  if (declared.length > 0) return withCookieCounts(definition, context, declared);

  const found = await Promise.all(
    (await readDirectory(root)).filter(isSafeProfileDirectory).map(async (directory) => {
      const database = await resolveCookieDatabase(definition, context, directory);
      return database === undefined ? undefined : { directory, name: directory };
    }),
  );
  return withCookieCounts(
    definition,
    context,
    found.filter((profile) => profile !== undefined),
  );
}

/**
 * Includes Firefox's Snap home beside its native home. Snap profiles use absolute
 * folders so cookie reads and lock checks keep pointing at the installation they
 * came from, even when both installs use the same name.
 */
export async function listSourceProfiles(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Promise<ReadonlyArray<BrowserImportSourceProfile>> {
  if (definition.engine !== "firefox" || context.platform !== "linux") {
    return listSourceProfilesInDirectory(definition, context);
  }
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const roots = [
    root,
    context.path.join(context.home, "snap", "firefox", "common", ".mozilla", "firefox"),
  ];
  const profiles = new Map<string, BrowserImportSourceProfile>();
  for (const directory of roots) {
    const found = await listSourceProfilesInDirectory(
      { ...definition, userDataDirectory: () => directory },
      context,
    );
    for (const profile of found) {
      const absolute = context.path.resolve(directory, profile.directory);
      if (!profiles.has(absolute)) {
        profiles.set(absolute, directory === root ? profile : { ...profile, directory: absolute });
      }
    }
  }
  return [...profiles.values()];
}

type ProcessLivenessProbe = (pid: number) => boolean;

/** Chromium's `SingletonLock` points at `<host>-<pid>`; only a dead pid of this host is stale. */
export function chromiumSingletonLockIsHeld(
  target: string,
  currentHost: string,
  isProcessAlive: ProcessLivenessProbe,
): boolean {
  const separator = target.lastIndexOf("-");
  if (separator <= 0) return true;
  const host = target.slice(0, separator);
  const pidText = target.slice(separator + 1);
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  // A pid means something only on this host. A foreign hostname can come from a
  // shared home folder, and cannot safely be declared stale from here.
  if (host !== currentHost) return true;
  return isProcessAlive(pid);
}

/** Windows sharing and lock violations reach Node as `EBUSY`. */
export const isWindowsLockHeldError = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "EBUSY";

/**
 * Whether a Windows lock file is held: it is opened with no sharing, so it stays
 * on disk after the process exits and only an open for write reveals a holder.
 * Permission failures do not prove a browser owns it.
 */
async function windowsLockIsHeld(lockPath: string): Promise<boolean> {
  try {
    const handle = await Fs.promises.open(lockPath, "r+");
    await handle.close();
    return false;
  } catch (error) {
    return isWindowsLockHeldError(error);
  }
}

/**
 * Chromium does not create its POSIX `SingletonLock` on Windows. The live cookie
 * database is opened without sharing instead, so probing each profile's jar is
 * the running signal there.
 */
export async function windowsChromiumCookiesAreHeld(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  lockIsHeld: (path: string) => Promise<boolean> = windowsLockIsHeld,
): Promise<boolean> {
  const profiles = await listSourceProfiles(definition, context);
  const held = await Promise.all(
    profiles.map(async (profile) => {
      const database = await resolveCookieDatabase(definition, context, profile.directory);
      return database === undefined ? false : lockIsHeld(database);
    }),
  );
  return held.some(Boolean);
}

/** Firefox's `lock` symlink points at `<address>:<pid>` (or `:+<pid>`). */
export function firefoxSymlinkLockIsHeld(
  target: string,
  localAddresses: ReadonlySet<string>,
  isProcessAlive: ProcessLivenessProbe,
): boolean {
  const separator = target.lastIndexOf(":");
  if (separator < 0) return true;
  // The owner half is whatever Firefox's resolver returned for the machine's
  // hostname (127.0.0.1 when the lookup fails, often 127.0.1.1 or a LAN
  // address), so a pid means something only when that address is one of ours.
  const owner = target.slice(0, separator);
  if (!localAddresses.has(owner)) return true;
  const pidText = target.slice(separator + 1).replace(/^\+/, "");
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return isProcessAlive(pid);
}

/**
 * `/usr/bin/python3` first, so a node started with launchd's bare `PATH` still
 * finds it; Linux distributions carry python3 on the default path.
 */
const FCNTL_PROBE_INTERPRETERS = ["/usr/bin/python3", "python3"] as const;

const FCNTL_PROBE_SCRIPT =
  "import fcntl,os,sys\n" +
  "fd=os.open(sys.argv[1],os.O_WRONLY)\n" +
  "try:\n" +
  "  fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\n" +
  "except BlockingIOError:\n" +
  "  print('held')\n" +
  "else:\n" +
  "  print('free')";

/**
 * Anything but "held" or "free" (no interpreter, or one that refused to run the
 * script, such as Apple's shim without the developer tools) is the probe being
 * unavailable, not evidence about the lock: that falls back to "not held", since
 * the SQLite snapshot copes with a live database's WAL anyway.
 */
export async function posixLockIsHeld(
  host: ImportHost,
  path: string,
  interpreters: ReadonlyArray<string> = FCNTL_PROBE_INTERPRETERS,
): Promise<boolean> {
  for (const interpreter of interpreters) {
    const verdict = await host
      .run(interpreter, ["-c", FCNTL_PROBE_SCRIPT, path])
      .then((result) => result.stdout.toString("utf8").trim())
      .catch(() => "");
    if (verdict === "held") return true;
    if (verdict === "free") return false;
  }
  return false;
}

/**
 * `.parentlock` (macOS, Linux) and `parent.lock` (Windows) are regular files held
 * with fcntl or a Windows handle and deliberately left on disk after exit, so
 * their presence is not proof of a running browser.
 */
async function firefoxProfileIsHeld(
  host: ImportHost,
  directory: string,
  context: BrowserImportPathContext,
  localAddresses: ReadonlySet<string>,
): Promise<boolean> {
  if (context.platform === "win32") {
    return windowsLockIsHeld(context.path.join(directory, "parent.lock"));
  }
  const symlinkHeld = await Fs.promises
    .readlink(context.path.join(directory, "lock"))
    .then((target) =>
      firefoxSymlinkLockIsHeld(target, localAddresses, (pid) => host.isProcessAlive(pid)),
    )
    .catch(() => false);
  if (symlinkHeld) return true;
  const parentLock = context.path.join(directory, ".parentlock");
  if (!(await databaseFileExists(parentLock))) return false;
  return posixLockIsHeld(host, parentLock);
}

export async function isSourceRunning(
  host: ImportHost,
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Promise<boolean> {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return false;
  // Safari keeps no lock and writes its jar atomically, so a running instance is
  // not a hazard there.
  if (definition.engine === "safari") return false;
  if (definition.engine === "chromium") {
    if (context.platform === "win32") return windowsChromiumCookiesAreHeld(definition, context);
    try {
      const target = await Fs.promises.readlink(context.path.join(root, "SingletonLock"));
      return chromiumSingletonLockIsHeld(target, host.hostname(), (pid) =>
        host.isProcessAlive(pid),
      );
    } catch (error) {
      return (error as { code?: unknown } | null)?.code !== "ENOENT";
    }
  }

  const profiles = await listSourceProfiles(definition, context);
  const localAddresses: ReadonlySet<string> =
    context.platform === "win32" ? new Set() : await host.addresses();
  const held = await Promise.all(
    profiles.map((profile) =>
      firefoxProfileIsHeld(
        host,
        context.path.isAbsolute(profile.directory)
          ? profile.directory
          : context.path.join(root, profile.directory),
        context,
        localAddresses,
      ),
    ),
  );
  return held.some(Boolean);
}

/**
 * Keyed off the cookie database rather than the user-data folder, because that
 * folder is not evidence the browser exists: installers of native messaging hosts
 * create an empty one for every Chromium fork they know about. Existence is
 * checked without opening the file, which matters for Safari: TCC permits `stat`
 * on its jar but refuses a read, so the user gets the Full Disk Access step
 * rather than Safari disappearing.
 */
export async function isSourceInstalled(
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Promise<boolean> {
  const profiles = await listSourceProfiles(definition, context);
  const found = await Promise.all(
    profiles.map(
      async (profile) =>
        (await resolveCookieDatabase(definition, context, profile.directory)) !== undefined,
    ),
  );
  return found.some(Boolean);
}
