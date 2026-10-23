// Public ids are public API (AGENTS.md rule 8): this check fails when a
// capability id, command name, slot id, contribution id or event type present
// at the merge base with origin/main is gone, unless main already declared it
// deprecated in `deprecations.json` and its `removeAfter` date has passed
// (docs/plans/agents.md D1247–D1249).
//
//   node scripts/public-ids.ts              compare HEAD's files with the merge base
//   node scripts/public-ids.ts --base <ref> compare with another ref
//   node scripts/public-ids.ts --list       print the ids found in HEAD's files
//
// Ids are read from the source, not from a running node: string literals in the
// places they are declared (see PATTERNS). An id built at run time (a template
// literal) is not seen, so neither its removal.

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

export const KINDS = ["capability", "command", "slot", "contribution", "event"] as const;
export type Kind = (typeof KINDS)[number];
export type Ids = Record<Kind, Set<string>>;

export interface Deprecation {
  readonly kind: Kind;
  readonly id: string;
  /** The id that replaces it, if any. */
  readonly replacedBy?: string;
  /** The day it was deprecated, YYYY-MM-DD. */
  readonly since: string;
  /** The first day it may be removed, YYYY-MM-DD. */
  readonly removeAfter: string;
  /** The decision that deprecated it, e.g. D1107. */
  readonly decision?: string;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export const DEPRECATIONS_FILE = "deprecations.json";
const ROOT = Path.resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["packages/", "plugins/", "apps/"];
const ID = String.raw`"([a-z][\w.@/-]*)"`;

/** Where each kind of id is declared in the source, as string literals. */
const PATTERNS: Record<Exclude<Kind, "event">, readonly RegExp[]> = {
  // Besides the `provides` of a plugin's package.json.
  capability: [new RegExp(String.raw`\b[A-Z][A-Z_]*_CAPABILITY\s*=\s*${ID}`, "g")],
  command: [new RegExp(String.raw`commands\.register\(\s*\{\s*name:\s*${ID}`, "g")],
  slot: [
    new RegExp(String.raw`<Slot\b[^>]*?\bname=${ID}`, "g"),
    new RegExp(String.raw`\buseSlot(?:<[^>()]*>)?\(\s*${ID}`, "g"),
    new RegExp(String.raw`\bslots\.contribute(?:<[^>()]*>)?\(\s*${ID}`, "g"),
    new RegExp(String.raw`\b\w*[sS]lot:\s*${ID}`, "g"),
    new RegExp(String.raw`\b[A-Z][A-Z_]*_SLOT\s*=\s*${ID}`, "g"),
  ],
  contribution: [
    new RegExp(
      String.raw`\bslots\.contribute(?:<[^>()]*>)?\(\s*(?:"[^"]*"|[\w.]+),\s*\{\s*id:\s*${ID}`,
      "g",
    ),
  ],
};
const COMMAND_DEFINITION = /\bname:\s*"([a-z][\w-]*(?:\.[\w-]+)+)",\s*description:/g;
/** `export const FooEvents = { … }`: every string value is an event type. */
const EVENTS_OBJECT = /\b[A-Z]\w*Events\s*=\s*\{([^}]*)\}/g;
const EMIT = new RegExp(String.raw`\.events\.emit\(\s*${ID}`, "g");
const STRING = /"([a-z][\w.@/-]*)"/g;

/** Source files whose ids are public: not tests, fixtures or builds. */
export const isSource = (path: string): boolean =>
  SOURCE_DIRS.some((dir) => path.startsWith(dir)) &&
  /\.(ts|tsx|json)$/.test(path) &&
  !/(^|\/)(test|tests|e2e|fixtures|dist|node_modules)\//.test(path) &&
  !/\.(test|spec|browser\.test)\.tsx?$/.test(path) &&
  (!path.endsWith(".json") || path.endsWith("/package.json"));

export function emptyIds(): Ids {
  return Object.fromEntries(KINDS.map((kind) => [kind, new Set<string>()])) as Ids;
}

/** Every public id declared in the files. */
export function extractIds(files: Iterable<SourceFile>): Ids {
  const ids = emptyIds();
  for (const { path, text } of files) {
    if (path.endsWith("package.json")) {
      try {
        const provides = (JSON.parse(text) as { jhin?: { provides?: object } }).jhin?.provides;
        for (const capability of Object.keys(provides ?? {})) ids.capability.add(capability);
      } catch {
        // Not a manifest this check reads.
      }
      continue;
    }
    // A command written as a definition object and registered elsewhere.
    if (text.includes("CommandDefinition")) {
      for (const match of text.matchAll(COMMAND_DEFINITION)) ids.command.add(match[1]!);
    }
    for (const [kind, patterns] of Object.entries(PATTERNS) as [Kind, RegExp[]][]) {
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) ids[kind].add(match[1]!);
      }
    }
    // Comments in an events object name payloads in braces: they are not its end.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const block of code.matchAll(EVENTS_OBJECT)) {
      for (const match of block[1]!.matchAll(STRING)) ids.event.add(match[1]!);
    }
    for (const match of text.matchAll(EMIT)) ids.event.add(match[1]!);
  }
  return ids;
}

export interface Removal {
  readonly kind: Kind;
  readonly id: string;
  readonly reason: "not-deprecated" | "deprecated-here" | "too-early";
  readonly removeAfter?: string;
}

/**
 * The ids of `base` gone from `head` that may not go yet. One may go once the
 * base already listed it in `deprecations.json` (a deprecation lands before
 * the removal, while the id still works) and `today` is past its
 * `removeAfter`. `declared` is the head's list: an id deprecated only there
 * is reported as deprecated in the same change.
 */
export function forbiddenRemovals(
  base: Ids,
  head: Ids,
  deprecated: readonly Deprecation[],
  declared: readonly Deprecation[],
  today: string,
): Removal[] {
  const find = (list: readonly Deprecation[], kind: Kind, id: string) =>
    list.find((entry) => entry.kind === kind && entry.id === id);
  const removals: Removal[] = [];
  for (const kind of KINDS) {
    for (const id of [...base[kind]].toSorted()) {
      if (head[kind].has(id)) continue;
      const entry = find(deprecated, kind, id);
      if (entry === undefined) {
        removals.push({
          kind,
          id,
          reason: find(declared, kind, id) === undefined ? "not-deprecated" : "deprecated-here",
        });
      } else if (today <= entry.removeAfter) {
        removals.push({ kind, id, reason: "too-early", removeAfter: entry.removeAfter });
      }
    }
  }
  return removals;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The entries of a `deprecations.json`; a malformed file throws, naming the entry. */
export function parseDeprecations(text: string | undefined): Deprecation[] {
  if (text === undefined) return [];
  const parsed = JSON.parse(text) as { deprecations?: unknown };
  if (!Array.isArray(parsed.deprecations))
    throw new Error(`${DEPRECATIONS_FILE}: "deprecations" must be an array`);
  return parsed.deprecations.map((entry: Partial<Deprecation>, index) => {
    const where = `${DEPRECATIONS_FILE}: deprecations[${index}]`;
    if (!KINDS.includes(entry.kind as Kind))
      throw new Error(`${where}: kind must be one of ${KINDS.join(", ")}`);
    if (typeof entry.id !== "string" || entry.id === "") throw new Error(`${where}: id is missing`);
    for (const field of ["since", "removeAfter"] as const) {
      if (typeof entry[field] !== "string" || !DAY.test(entry[field]))
        throw new Error(`${where}: ${field} must be a date, YYYY-MM-DD`);
    }
    return entry as Deprecation;
  });
}

// --- Reading a ref --------------------------------------------------------------

function git(args: readonly string[], input?: string): string {
  return ChildProcess.execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

function mergeBase(): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref]).trim();
    } catch {
      // try the next ref
    }
  }
  throw new Error("public-ids: no origin/main or main to compare with; pass --base <ref>");
}

/** The source files of a commit, read from git's objects. */
function filesAt(ref: string): SourceFile[] {
  const paths = git(["ls-tree", "-r", "--name-only", ref, "--", ...SOURCE_DIRS])
    .split("\n")
    .filter(isSource);
  const out = ChildProcess.execFileSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input: paths.map((path) => `${ref}:${path}`).join("\n") + "\n",
    maxBuffer: 1024 * 1024 * 1024,
  });
  const files: SourceFile[] = [];
  let offset = 0;
  for (const path of paths) {
    const end = out.indexOf(10, offset);
    const size = Number(out.subarray(offset, end).toString("utf8").split(" ")[2]);
    files.push({ path, text: out.subarray(end + 1, end + 1 + size).toString("utf8") });
    offset = end + 1 + size + 1;
  }
  return files;
}

/** The source files as they are now in the working tree, tracked or new. */
function filesNow(): SourceFile[] {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SOURCE_DIRS])
    .split("\n")
    .filter((path) => isSource(path) && Fs.existsSync(Path.join(ROOT, path)))
    .map((path) => ({ path, text: Fs.readFileSync(Path.join(ROOT, path), "utf8") }));
}

function deprecationsAt(ref: string): string | undefined {
  try {
    const listed = git(["ls-tree", "--name-only", ref, "--", DEPRECATIONS_FILE]).trim();
    return listed === "" ? undefined : git(["show", `${ref}:${DEPRECATIONS_FILE}`]);
  } catch {
    return undefined;
  }
}

function main(argv: readonly string[]): number {
  const head = extractIds(filesNow());
  if (argv.includes("--list")) {
    for (const kind of KINDS) for (const id of [...head[kind]].toSorted()) console.log(kind, id);
    return 0;
  }
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? mergeBase() : argv[baseIndex + 1]!;
  const declaredPath = Path.join(ROOT, DEPRECATIONS_FILE);
  const removals = forbiddenRemovals(
    extractIds(filesAt(base)),
    head,
    parseDeprecations(deprecationsAt(base)),
    parseDeprecations(
      Fs.existsSync(declaredPath) ? Fs.readFileSync(declaredPath, "utf8") : undefined,
    ),
    new Date().toISOString().slice(0, 10),
  );
  const counts = KINDS.map((kind) => `${kind} ${head[kind].size}`).join(", ");
  if (removals.length === 0) {
    console.log(`public-ids: no public id removed since ${base.slice(0, 12)} (${counts})`);
    return 0;
  }
  console.error(
    `public-ids: ${removals.length} public id(s) of ${base.slice(0, 12)} are gone (AGENTS.md rule 8):`,
  );
  for (const removal of removals) {
    const why =
      removal.reason === "not-deprecated"
        ? `not deprecated: keep it working and list it in ${DEPRECATIONS_FILE} first`
        : removal.reason === "deprecated-here"
          ? `deprecated in this same change: land the deprecation on main first, remove it after removeAfter`
          : `deprecated, but it may go only after ${removal.removeAfter}`;
    console.error(`  ${removal.kind} ${removal.id}: ${why}`);
  }
  console.error("Renaming or removing a public id is the owner's decision (docs/README.md).");
  return 1;
}

if (import.meta.filename === process.argv[1]) process.exitCode = main(process.argv.slice(2));
