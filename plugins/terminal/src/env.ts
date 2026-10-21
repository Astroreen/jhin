// The shell's environment follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/Manager.ts (TERMINAL_ENV_BLOCKLIST, shouldExcludeTerminalEnvKey,
// stripAppImageRuntimeEnv, createTerminalSpawnEnv).

/** The node's own ports would confuse dev servers started in a terminal. */
const BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
/** Jhin's own settings (T3's `T3CODE_*`) and the web client's build variables. */
const BLOCKED_PREFIXES = ["JHIN_", "VITE_"];

const APPIMAGE_RUNTIME_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"];
const APPIMAGE_PATH_LIKE_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
];

/** The owner's narrowing of the environment (`jhin.terminal.env`, D461). */
export interface EnvFilter {
  /** Names to drop; `NAME_*` drops a prefix. */
  readonly strip?: readonly string[] | undefined;
  /** When set, the only names passed on; `NAME_*` keeps a prefix. */
  readonly keep?: readonly string[] | undefined;
}

function matcher(patterns: readonly string[], insensitive: boolean): (name: string) => boolean {
  const fold = (value: string) => (insensitive ? value.toUpperCase() : value);
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) prefixes.push(fold(pattern.slice(0, -1)));
    else exact.add(fold(pattern));
  }
  return (name) => {
    const folded = fold(name);
    return exact.has(folded) || prefixes.some((prefix) => folded.startsWith(prefix));
  };
}

/**
 * An AppImage mounts the app under a temporary folder and puts it on `PATH`
 * and friends: a terminal would find the app's tools instead of the user's.
 */
function stripAppImage(env: Record<string, string>): Record<string, string> {
  if (env["APPIMAGE"] === undefined && env["APPDIR"] === undefined) return env;
  const scrubbed = { ...env };
  for (const key of APPIMAGE_RUNTIME_KEYS) delete scrubbed[key];
  const appDir = env["APPDIR"]?.replace(/\/+$/, "");
  if (appDir !== undefined && appDir.length > 0) {
    for (const key of APPIMAGE_PATH_LIKE_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter(
          (segment) =>
            segment.length > 0 && segment !== appDir && !segment.startsWith(`${appDir}/`),
        );
      if (kept.length > 0) scrubbed[key] = kept.join(":");
      else delete scrubbed[key];
    }
  }
  return scrubbed;
}

/**
 * What a shell starts with: the node's environment without what T3 drops and
 * what the owner strips (or keeps only what the owner keeps), the terminal's
 * own variables over it, and `TERM` and `COLORTERM` for xterm.js.
 */
export function shellEnv(options: {
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly filter?: EnvFilter | undefined;
  /** The terminal's own variables (`terminals.open`'s `env`, D462). */
  readonly extra?: Readonly<Record<string, string>> | undefined;
}): Record<string, string> {
  const windows = options.platform === "win32";
  const blocked = (name: string) => {
    const upper = name.toUpperCase();
    return BLOCKLIST.has(upper) || BLOCKED_PREFIXES.some((prefix) => upper.startsWith(prefix));
  };
  const stripped = matcher(options.filter?.strip ?? [], windows);
  const kept =
    options.filter?.keep === undefined ? undefined : matcher(options.filter.keep, windows);
  // The AppImage's mount goes first: `keep` may drop the APPDIR that finds it.
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.base))
    if (value !== undefined) base[name] = value;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(stripAppImage(base))) {
    if (value === undefined || blocked(name) || stripped(name)) continue;
    if (kept !== undefined && !kept(name)) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    // Windows variables are case-insensitive: replace `Path` when `PATH` is given.
    const existing = windows
      ? Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
      : undefined;
    if (existing !== undefined && existing !== name) delete env[existing];
    env[name] = value;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] ??= "truecolor";
  return env;
}

/** A terminal's own variables in one comparable form; "" for none. */
export function envKey(env: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return "";
  return JSON.stringify(entries.toSorted(([left], [right]) => (left < right ? -1 : 1)));
}
