// Several Codex accounts on one node (providers.md D1319). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/server/src/provider/Drivers/CodexHomeLayout.ts
// (the auth overlay of a shadow home: materializeCodexShadowHome and its entry rules).
import * as Fs from "node:fs";
import * as Path from "node:path";

/** Directories every account shares even before Codex made them. */
const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
] as const;

/** An account's own: its sign-in and the models it may use. */
const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
/** Kept apart per home (Finder's metadata included). */
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", ".DS_Store"]);
/**
 * Locks Codex makes itself when it starts in a shadow home before the shared home has them:
 * a local copy is replaced with the shared link.
 */
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Set(["mcp-oauth-locks", ".sqlite-maintenance.lock"]);

function linkState(path: string): "missing" | "not-symlink" | { target: string } {
  try {
    return { target: Fs.readlinkSync(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "EINVAL") return "not-symlink";
    throw error;
  }
}

/**
 * Makes `shadowHome` an account's Codex home over `sharedHome` (T3's auth overlay): every
 * entry of the shared home is linked in, so threads, skills and config are shared, but
 * `auth.json` and `models_cache.json` stay the account's own. Run before each start of its
 * Codex (synchronously, as a start is): entries the shared home gained since are linked too.
 */
export function materializeShadowHome(sharedHome: string, shadowHome: string): void {
  const shared = Path.resolve(sharedHome);
  const shadow = Path.resolve(shadowHome);
  if (shared === shadow) {
    throw new Error(
      `Codex shadow home path '${shadow}' must be different from the shared home path '${shared}'.`,
    );
  }
  // One inside the other would link a home into itself.
  const inside = (outer: string, inner: string) => {
    const relative = Path.relative(outer, inner);
    return relative !== "" && !relative.startsWith("..") && !Path.isAbsolute(relative);
  };
  if (inside(shared, shadow) || inside(shadow, shared)) {
    throw new Error(
      `Codex shadow home path '${shadow}' must not be inside the shared home path '${shared}', nor contain it.`,
    );
  }
  Fs.mkdirSync(shared, { recursive: true });
  Fs.mkdirSync(shadow, { recursive: true });
  for (const name of KNOWN_SHARED_DIRECTORIES) {
    Fs.mkdirSync(Path.join(shared, name), { recursive: true });
  }
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const name of Fs.readdirSync(shared)) {
    if (!PRIVATE_ENTRY_NAMES.has(name) && !SHADOW_LOCAL_ENTRY_NAMES.has(name)) entries.add(name);
  }
  // A private entry linked by an older layout is unlinked, but never auth.json (below).
  for (const name of PRIVATE_ENTRY_NAMES) {
    if (name === "auth.json") continue;
    const path = Path.join(shadow, name);
    if (typeof linkState(path) === "object") Fs.rmSync(path);
  }
  for (const name of entries) {
    const target = Path.join(shared, name);
    const link = Path.join(shadow, name);
    const state = linkState(link);
    if (state === "not-symlink") {
      if (!REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(name)) {
        throw new Error(
          `Cannot create Codex shadow home entry '${name}' because '${link}' already exists and is not a symlink.`,
        );
      }
      Fs.rmSync(link, { recursive: true, force: true });
      Fs.symlinkSync(target, link);
    } else if (state === "missing") {
      Fs.symlinkSync(target, link);
    } else if (Path.resolve(Path.dirname(link), state.target) !== target) {
      Fs.rmSync(link);
      Fs.symlinkSync(target, link);
    }
  }
  // A link to an entry the main home no longer has goes.
  for (const name of Fs.readdirSync(shadow)) {
    if (entries.has(name) || PRIVATE_ENTRY_NAMES.has(name)) continue;
    const state = linkState(Path.join(shadow, name));
    if (
      typeof state === "object" &&
      Path.resolve(shadow, state.target).startsWith(`${shared}${Path.sep}`)
    ) {
      Fs.rmSync(Path.join(shadow, name));
    }
  }
  // The account's sign-in is its own file: a link would sign every account in as one.
  if (typeof linkState(Path.join(shadow, "auth.json")) === "object") {
    throw new Error(
      `Codex shadow home private entry 'auth.json' at '${Path.join(shadow, "auth.json")}' must be a real file, not a symlink.`,
    );
  }
}
