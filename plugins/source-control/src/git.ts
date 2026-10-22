// Reading a repository with the git CLI. The commands and the way their output
// is read follow T3 Code's GitVcsDriverCore (MIT, see THIRD_PARTY_NOTICES.md):
// `status --porcelain=2 --branch`, `diff --numstat` against HEAD for the
// working tree, `merge-base` for a branch's changes.
import { spawn } from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import {
  MAX_DIFF_FILE_BYTES,
  MAX_PATCH_BYTES,
  MAX_STATUS_FILES,
  type Branch,
  type ChangedFile,
  type DiffFileContents,
  type DiffFileRequest,
  type DiffScope,
  type FileChangeStatus,
  type SourceControlErrorCode,
  type WorkingTree,
} from "@jhin/source-control-api";

/** git's empty tree: what an unborn `HEAD` is compared against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Untracked files whose lines are counted at most; the rest count as changed without lines. */
const MAX_COUNTED_UNTRACKED = 1000;
/** Untracked files larger than this count as changed without lines. */
const MAX_COUNTED_BYTES = 4 * 1024 * 1024;
/** No git command of a status should take longer. */
const GIT_TIMEOUT_MS = 30_000;

export class SourceControlError extends Error {
  readonly code: SourceControlErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: SourceControlErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SourceControlError";
    this.code = code;
    this.details = details;
  }
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  /** The output was cut at `maxBytes`. */
  readonly truncated: boolean;
}

export interface RunOptions {
  readonly cwd: string;
  /** Exit codes that are answers, not failures (default: 0 only). */
  readonly ok?: readonly number[];
  /** Stops reading (and the process) after this many bytes of stdout. */
  readonly maxBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Written to the program's stdin. */
  readonly input?: string;
  /** Called with output as it arrives (a commit's hooks print while they run). */
  readonly onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

/** A spawn error such as ENOENT: the program is missing. */
export class SpawnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Runs a program without a shell; rejects with `SpawnError` when it cannot start. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const max = options.maxBytes;
      if (max !== undefined && size + chunk.length > max) {
        out.push(chunk.subarray(0, max - size));
        size = max;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      out.push(chunk);
      size += chunk.length;
      options.onOutput?.("stdout", chunk.toString("utf8"));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      err.push(chunk);
      options.onOutput?.("stderr", chunk.toString("utf8"));
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new SpawnError(error.code ?? "SPAWN_FAILED", error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? (truncated ? 0 : 1),
        truncated,
      });
    });
  });
}

/** Runs git commands in one repository. */
export interface Git {
  (args: readonly string[], options?: Omit<RunOptions, "cwd">): Promise<RunResult>;
}

/** Environment of every git command: no prompts, no index writes from reads, stable output. */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  // A status must not take the index lock: the node would fight the user's own git.
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

export function createGit(gitPath: string, cwd: string): Git {
  return async (args, options = {}) => {
    const result = await run(gitPath, ["--no-pager", "-c", "core.quotepath=off", ...args], {
      cwd,
      ...options,
      env: { ...GIT_ENV, ...options.env },
    });
    const ok = options.ok ?? [0];
    if (!ok.includes(result.code) && !result.truncated) {
      throw new SourceControlError(
        "GIT_FAILED",
        firstLine(result.stderr) ?? `git ${args[0]} failed with exit code ${result.code}`,
        { args: [...args], code: result.code },
      );
    }
    return result;
  };
}

const firstLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((line) => line.replace(/^(fatal|error): /, "").trim())
    .find((line) => line !== "");

/** Where a project's repository is, or why it has none. */
export type Repository =
  | {
      readonly isRepo: true;
      readonly root: string;
      readonly gitDir: string;
      readonly commonDir: string;
    }
  | { readonly isRepo: false; readonly reason: string };

export async function locate(gitPath: string, path: string): Promise<Repository> {
  try {
    const stat = await Fs.stat(path);
    if (!stat.isDirectory()) return { isRepo: false, reason: "The project's folder is missing" };
  } catch {
    return { isRepo: false, reason: "The project's folder is missing" };
  }
  let result: RunResult;
  try {
    result = await run(
      gitPath,
      ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
      { cwd: path, env: GIT_ENV },
    );
  } catch (error) {
    if (error instanceof SpawnError && error.code === "ENOENT") {
      return { isRepo: false, reason: "git is not installed on this node" };
    }
    throw error;
  }
  if (result.code !== 0) return { isRepo: false, reason: "Not a git repository" };
  const [root, gitDir, commonDir] = result.stdout.split("\n").map((line) => line.trim());
  if (root === undefined || root === "" || gitDir === undefined || commonDir === undefined) {
    return { isRepo: false, reason: "Not a git repository" };
  }
  return { isRepo: true, root, gitDir, commonDir: Path.resolve(path, commonDir) };
}

/** What `git status --porcelain=2 --branch` says about `HEAD` and its upstream. */
export interface Head {
  readonly branch: string | null;
  /** `HEAD` has no commit yet. */
  readonly unborn: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
}

interface StatusEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: FileChangeStatus;
}

function changeStatus(xy: string): FileChangeStatus {
  const [x = ".", y = "."] = xy;
  const either = (code: string) => x === code || y === code;
  if (either("D")) return "deleted";
  if (either("A")) return "added";
  if (either("R")) return "renamed";
  if (either("C")) return "copied";
  if (either("T")) return "type-changed";
  return "modified";
}

/** Parses `git status --porcelain=2 --branch -z`. */
export function parseStatus(output: string): { head: Head; entries: StatusEntry[] } {
  const records = output.split("\0");
  let branch: string | null = null;
  let unborn = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record === "") continue;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") unborn = value === "(initial)";
      else if (key === "branch.head") branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const fields = record.split(" ");
      entries.push({ path: fields.slice(8).join(" "), status: changeStatus(fields[1] ?? "") });
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record
      const fields = record.split(" ");
      const previousPath = records[++index] ?? "";
      entries.push({
        path: fields.slice(9).join(" "),
        previousPath,
        status: changeStatus(fields[1] ?? ""),
      });
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      entries.push({ path: record.split(" ").slice(10).join(" "), status: "conflicted" });
    } else if (kind === "?") {
      entries.push({ path: record.slice(2), status: "untracked" });
    }
  }
  return { head: { branch, unborn, upstream, ahead, behind }, entries };
}

interface NumstatEntry {
  readonly path: string;
  readonly previousPath?: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

/** Parses `git diff --numstat -z`. */
export function parseNumstat(output: string): NumstatEntry[] {
  const records = output.split("\0");
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record === "") continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) continue;
    const binary = match[1] === "-" || match[2] === "-";
    const counts = {
      insertions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    };
    if (match[3] === "") {
      // A rename or copy: the old and the new path follow as their own records.
      const previousPath = records[++index] ?? "";
      const path = records[++index] ?? "";
      entries.push({ path, previousPath, ...counts });
    } else {
      entries.push({ path: match[3]!, ...counts });
    }
  }
  return entries;
}

const NAME_STATUS: Readonly<Record<string, FileChangeStatus>> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  C: "copied",
  T: "type-changed",
  U: "conflicted",
};

/** Parses `git diff --name-status -z`: a status letter (with a score for renames), then paths. */
export function parseNameStatus(output: string): { path: string; status: FileChangeStatus }[] {
  const records = output.split("\0");
  const entries: { path: string; status: FileChangeStatus }[] = [];
  for (let index = 0; index < records.length; index++) {
    const code = records[index]!;
    if (code === "") continue;
    const letter = code[0]!;
    // A rename or copy names the old path, then the new one.
    if (letter === "R" || letter === "C") index++;
    const path = records[++index];
    if (path === undefined) break;
    entries.push({ path, status: NAME_STATUS[letter] ?? "modified" });
  }
  return entries;
}

/** Untracked files counted at the same time: each holds one file descriptor and one buffer. */
const COUNT_CONCURRENCY = 8;
/** The read buffer of a count; git decides "binary" from the first 8000 bytes too. */
const COUNT_CHUNK_BYTES = 64 * 1024;

/**
 * Lines of an untracked file, read in chunks so memory stays at one chunk;
 * `binary` when its first 8000 bytes hold a NUL (as git decides) or it is too
 * large to count.
 */
export async function countLines(file: string): Promise<{ lines: number; binary: boolean }> {
  let handle: Fs.FileHandle | undefined;
  try {
    const stat = await Fs.stat(file);
    if (!stat.isFile()) return { lines: 0, binary: false };
    if (stat.size > MAX_COUNTED_BYTES) return { lines: 0, binary: true };
    if (stat.size === 0) return { lines: 0, binary: false };
    handle = await Fs.open(file, "r");
    const chunk = Buffer.alloc(COUNT_CHUNK_BYTES);
    let lines = 0;
    let position = 0;
    let last = 10;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const read = chunk.subarray(0, bytesRead);
      if (position < 8000 && read.subarray(0, 8000 - position).includes(0)) {
        return { lines: 0, binary: true };
      }
      for (const byte of read) if (byte === 10) lines++;
      last = read[bytesRead - 1]!;
      position += bytesRead;
    }
    if (position > 0 && last !== 10) lines++;
    return { lines, binary: false };
  } catch {
    return { lines: 0, binary: false };
  } finally {
    await handle?.close();
  }
}

/** Maps `items` with at most `limit` calls of `map` running at once, keeping their order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Joins status entries with their line counts into changed files, sorted by path. */
async function changedFiles(
  root: string,
  entries: readonly StatusEntry[],
  numstat: readonly NumstatEntry[],
): Promise<ChangedFile[]> {
  const counts = new Map(numstat.map((entry) => [entry.path, entry]));
  // Only the first untracked files have their lines counted; the rest count as changed.
  const untracked = entries.filter((entry) => entry.status === "untracked");
  const lines = new Map(
    await mapLimited(
      untracked.slice(0, MAX_COUNTED_UNTRACKED),
      COUNT_CONCURRENCY,
      async (entry) => [entry.path, await countLines(Path.join(root, entry.path))] as const,
    ),
  );
  const files = entries.map((entry): ChangedFile => {
    const base = {
      path: entry.path,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      status: entry.status,
    };
    if (entry.status === "untracked") {
      const counted = lines.get(entry.path);
      return {
        ...base,
        insertions: counted?.lines ?? 0,
        deletions: 0,
        binary: counted?.binary ?? false,
      };
    }
    const stat = counts.get(entry.path);
    return {
      ...base,
      insertions: stat?.insertions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
    };
  });
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function summarize(files: readonly ChangedFile[]): WorkingTree {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    insertions += file.insertions;
    deletions += file.deletions;
  }
  return {
    files: files.slice(0, MAX_STATUS_FILES),
    fileCount: files.length,
    insertions,
    deletions,
    truncated: files.length > MAX_STATUS_FILES,
  };
}

export interface LocalStatus {
  readonly head: Head;
  readonly files: ChangedFile[];
}

/** `HEAD`, its upstream and every uncommitted change (untracked files included). */
export async function readLocalStatus(git: Git, root: string): Promise<LocalStatus> {
  const status = await git(["status", "--porcelain=2", "--branch", "-z", "--untracked-files=all"]);
  const { head, entries } = parseStatus(status.stdout);
  if (entries.length === 0) return { head, files: [] };
  const numstat = await git([
    "diff",
    "-M",
    "--numstat",
    "-z",
    head.unborn ? EMPTY_TREE : "HEAD",
    "--",
  ]);
  return { head, files: await changedFiles(root, entries, parseNumstat(numstat.stdout)) };
}

export async function readRemoteUrl(git: Git): Promise<string | null> {
  const remotes = (await git(["remote"])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (remote === undefined) return null;
  const url = await git(["remote", "get-url", remote], { ok: [0, 2, 128] });
  return url.code === 0 ? url.stdout.trim() || null : null;
}

/** `origin/HEAD`'s branch, else `main` or `master` when it exists locally. */
export async function readDefaultBranch(git: Git): Promise<string | null> {
  const symbolic = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    ok: [0, 1, 128],
  });
  const remoteHead = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  if (remoteHead.startsWith("origin/") && remoteHead.length > "origin/".length) {
    return remoteHead.slice("origin/".length);
  }
  for (const candidate of ["main", "master"]) {
    const found = await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], {
      ok: [0, 1, 128],
    });
    if (found.code === 0) return candidate;
  }
  return null;
}

/** Local and remote branches, the current one first, then by name. */
export async function readBranches(git: Git, defaultBranch: string | null): Promise<Branch[]> {
  const output = await git([
    "for-each-ref",
    "--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches: Branch[] = [];
  for (const line of output.stdout.split("\n")) {
    if (line === "") continue;
    const [ref = "", name = "", upstream = "", head = ""] = line.split("\t");
    const isRemote = ref.startsWith("refs/remotes/");
    // `origin/HEAD` points at a branch listed anyway.
    if (isRemote && ref.endsWith("/HEAD")) continue;
    branches.push({
      name,
      current: head === "*",
      isDefault: !isRemote && name === defaultBranch,
      isRemote,
      upstream: upstream === "" ? null : upstream,
    });
  }
  return branches.toSorted(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      Number(a.isRemote) - Number(b.isRemote) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** Whether `name` is a valid new branch name. */
async function isValidBranchName(git: Git, name: string): Promise<boolean> {
  if (name.startsWith("-")) return false;
  const result = await git(["check-ref-format", "--branch", name], { ok: [0, 1, 128] });
  return result.code === 0;
}

export async function checkout(
  git: Git,
  branch: string,
  options: { create: boolean; remotes: readonly string[] },
): Promise<void> {
  // A name git would read as an option is refused, whether or not such a ref exists.
  if (branch.startsWith("-")) {
    throw new SourceControlError("BRANCH_INVALID", `${branch} is not a valid branch name`, {
      branch,
    });
  }
  if (options.create) {
    if (!(await isValidBranchName(git, branch))) {
      throw new SourceControlError("BRANCH_INVALID", `${branch} is not a valid branch name`, {
        branch,
      });
    }
    await git(["switch", "--create", branch]);
    return;
  }
  const local = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    ok: [0, 1, 128],
  });
  if (local.code === 0) {
    await git(["switch", branch]);
    return;
  }
  // A remote branch (`origin/feature`) is checked out as a local branch following it.
  const remote = await git(["show-ref", "--verify", "--quiet", `refs/remotes/${branch}`], {
    ok: [0, 1, 128],
  });
  if (remote.code === 0 && options.remotes.some((name) => branch.startsWith(`${name}/`))) {
    await git(["switch", "--track", branch]);
    return;
  }
  throw new SourceControlError("BRANCH_NOT_FOUND", `No branch ${branch}`, { branch });
}

export interface PatchOptions {
  readonly scope: DiffScope;
  /** For `branch`: the base to compare with; the default branch when absent. */
  readonly base: string | null;
  readonly ignoreWhitespace: boolean;
}

export interface Patch {
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly files: ChangedFile[];
}

/** Resolves a base name to a commit: the name itself, else the same branch on `origin`. */
async function resolveBase(git: Git, base: string): Promise<string | undefined> {
  for (const candidate of [base, `origin/${base}`]) {
    if (candidate.startsWith("-")) continue;
    const found = await git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
      ok: [0, 1, 128],
    });
    if (found.code === 0) return candidate;
  }
  return undefined;
}

/** What a scope compares the working tree with: `HEAD`, or the merge base with the base. */
async function diffFrom(
  git: Git,
  head: { readonly unborn: boolean },
  options: { scope: DiffScope; base: string | null },
): Promise<{ from: string; baseRef: string | null }> {
  let from = head.unborn ? EMPTY_TREE : "HEAD";
  let baseRef: string | null = null;
  if (options.scope === "branch") {
    if (head.unborn) {
      throw new SourceControlError("BRANCH_NOT_FOUND", "The branch has no commit yet");
    }
    if (options.base === null) {
      throw new SourceControlError(
        "BRANCH_NOT_FOUND",
        "The repository has no default branch to compare with",
      );
    }
    const resolved = await resolveBase(git, options.base);
    if (resolved === undefined) {
      throw new SourceControlError("BRANCH_NOT_FOUND", `No branch ${options.base}`, {
        branch: options.base,
      });
    }
    baseRef = resolved;
    from = (await git(["merge-base", "HEAD", resolved])).stdout.trim();
  }
  return { from, baseRef };
}

const fileUnavailable = (message: string, path: string) =>
  new SourceControlError("DIFF_FILE_UNAVAILABLE", message, { path });

/** A file of a revision whole; T3's limits and messages (D921). */
async function readFileAt(git: Git, revision: string, path: string): Promise<string> {
  const shown = await git(["show", "--end-of-options", `${revision}:${path}`], {
    ok: [0, 128],
    // Cut, and marked truncated, once it passes the limit.
    maxBytes: MAX_DIFF_FILE_BYTES,
  });
  if (shown.code !== 0 && !shown.truncated) {
    throw fileUnavailable(`Could not read diff file '${path}'.`, path);
  }
  if (shown.truncated) {
    throw fileUnavailable(`Diff file '${path}' exceeds the 1 MB expansion limit.`, path);
  }
  if (shown.stdout.includes("\0")) {
    throw fileUnavailable(`Cannot expand binary file '${path}'.`, path);
  }
  return shown.stdout;
}

const isWithin = (root: string, candidate: string) => {
  const relative = Path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
};

/** A working tree file whole, never one that leads out of the repository (T3's checks). */
async function readWorkingFile(root: string, path: string): Promise<string> {
  const outside = () =>
    fileUnavailable(`Diff file '${path}' resolves outside the review workspace.`, path);
  const requested = Path.resolve(root, path);
  if (!isWithin(root, requested)) throw outside();
  // A link is what git diffs it as: the path it holds, never the file it leads to.
  const link = await Fs.lstat(requested).catch(() => undefined);
  if (link?.isSymbolicLink() === true) {
    try {
      return await Fs.readlink(requested);
    } catch {
      throw fileUnavailable(`Could not read diff file '${path}'.`, path);
    }
  }
  let real: string;
  let realRoot: string;
  try {
    [realRoot, real] = await Promise.all([Fs.realpath(root), Fs.realpath(requested)]);
  } catch {
    throw fileUnavailable(`Could not resolve diff file '${path}'.`, path);
  }
  if (!isWithin(realRoot, real)) throw outside();
  // One handle for the checks and the read, so the file read is the one checked. A
  // folder of the path swapped for a link between `realpath` and `open` could lead the
  // open elsewhere, so the path is resolved again once the file is open, and the open
  // file must be the very file it resolves to, still inside the repository.
  let bytes: Buffer;
  let handle: Fs.FileHandle | undefined;
  try {
    handle = await Fs.open(real, Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW);
    const info = await handle.stat();
    const again = await Fs.realpath(requested);
    const there = await Fs.stat(again);
    if (!isWithin(realRoot, again) || there.dev !== info.dev || there.ino !== info.ino) {
      throw outside();
    }
    if (!info.isFile()) throw fileUnavailable(`Diff path '${path}' is not a file.`, path);
    if (info.size > MAX_DIFF_FILE_BYTES) {
      throw fileUnavailable(`Diff file '${path}' exceeds the 1 MB expansion limit.`, path);
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof SourceControlError) throw error;
    throw fileUnavailable(`Could not read diff file '${path}'.`, path);
  } finally {
    await handle?.close();
  }
  if (bytes.length > MAX_DIFF_FILE_BYTES) {
    throw fileUnavailable(`Diff file '${path}' exceeds the 1 MB expansion limit.`, path);
  }
  if (bytes.includes(0)) throw fileUnavailable(`Cannot expand binary file '${path}'.`, path);
  return bytes.toString("utf8");
}

/** A file of a diff as the diff itself names it: its paths and what happened to it. */
export interface DiffEntry {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly status: FileChangeStatus;
}

/**
 * Both sides of one of `files` (the diff's own list) whole, `to` `null` for the
 * working tree (D921). Only a file the diff lists is read, and what it says the
 * file is decides which side is empty, so no other path of the node is reachable.
 */
export async function readDiffFileBetween(
  git: Git,
  root: string,
  range: { from: string; to: string | null },
  files: readonly DiffEntry[],
  file: DiffFileRequest,
): Promise<DiffFileContents> {
  const entry = files.find(
    (candidate) =>
      candidate.path === file.path &&
      (candidate.previousPath ?? candidate.path) === (file.previousPath ?? file.path),
  );
  if (entry === undefined) {
    throw fileUnavailable(`Diff file '${file.path}' is not part of this diff.`, file.path);
  }
  const added = entry.status === "added" || entry.status === "untracked";
  const [oldContents, newContents] = await Promise.all([
    added ? "" : readFileAt(git, range.from, entry.previousPath ?? entry.path),
    entry.status === "deleted"
      ? ""
      : range.to === null
        ? readWorkingFile(root, entry.path)
        : readFileAt(git, range.to, entry.path),
  ]);
  return { oldContents, newContents };
}

/**
 * The tracked files a diff against `from` changes, with what happened to each:
 * `readPatch`'s list for the branch scope, and what `readDiffFile` may read.
 */
async function trackedChanges(
  git: Git,
  from: string,
  whitespace: readonly string[],
  /** Only these paths (taken literally); every changed file without. */
  paths: readonly string[] = [],
): Promise<ChangedFile[]> {
  const range = [
    "-M",
    "-z",
    ...whitespace,
    from,
    "--",
    ...paths.map((path) => `:(literal)${path}`),
  ];
  const [numstat, names] = await Promise.all([
    git(["diff", "--numstat", ...range]),
    git(["diff", "--name-status", ...range]),
  ]);
  const statuses = new Map(
    parseNameStatus(names.stdout).map((entry) => [entry.path, entry.status]),
  );
  return parseNumstat(numstat.stdout).map((entry): ChangedFile => ({
    path: entry.path,
    ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
    status: statuses.get(entry.path) ?? (entry.previousPath === undefined ? "modified" : "renamed"),
    insertions: entry.insertions,
    deletions: entry.deletions,
    binary: entry.binary,
  }));
}

/** One file of `readPatch`'s diff, both sides whole (D921). */
export async function readDiffFile(
  git: Git,
  root: string,
  options: { scope: DiffScope; base: string | null },
  file: DiffFileRequest,
): Promise<DiffFileContents> {
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], { ok: [0, 1, 128] });
  const { from } = await diffFrom(git, { unborn: head.code !== 0 }, options);
  // The files `readPatch` shows, listed the same way but only for this file's paths
  // (a rename is found from both): tracked ones against `from` (whitespace never hides
  // a file from the list), untracked ones as added.
  const paths = [...new Set([file.path, file.previousPath ?? file.path])];
  // git refuses a pathspec outside the repository; no diff lists one anyway.
  if (paths.some((path) => !isWithin(root, Path.resolve(root, path)))) {
    throw fileUnavailable(`Diff file '${file.path}' is not part of this diff.`, file.path);
  }
  const [tracked, untracked] = await Promise.all([
    trackedChanges(git, from, [], paths),
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", `:(literal)${file.path}`]),
  ]);
  const files: DiffEntry[] = [
    ...tracked,
    ...untracked.stdout
      .split("\0")
      .filter((path) => path !== "")
      .map((path) => ({ path, status: "untracked" as const })),
  ];
  return readDiffFileBetween(git, root, { from, to: null }, files, file);
}

/**
 * A unified diff of the working tree against `HEAD` (`uncommitted`) or against
 * where the branch left its base (`branch`), untracked files as additions.
 */
export async function readPatch(
  git: Git,
  root: string,
  local: LocalStatus,
  options: PatchOptions,
): Promise<Patch> {
  const { from, baseRef } = await diffFrom(git, local.head, options);
  const whitespace = options.ignoreWhitespace ? ["--ignore-all-space"] : [];
  const tracked = await git(
    ["diff", "-M", "--no-color", "--no-ext-diff", ...whitespace, from, "--"],
    { maxBytes: MAX_PATCH_BYTES },
  );
  let patch = tracked.stdout;
  let truncated = tracked.truncated;
  const untracked = local.files.filter((file) => file.status === "untracked");
  for (const file of untracked) {
    if (truncated) break;
    const added = await git(
      ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file.path],
      { ok: [0, 1], maxBytes: MAX_PATCH_BYTES - Buffer.byteLength(patch) },
    );
    patch += added.stdout;
    truncated = added.truncated;
  }
  let files = local.files;
  if (options.scope === "branch") {
    // The branch's diff is the working tree against the merge base: its own name-status
    // says what each file is (added, deleted, renamed) across commits and edits alike.
    const committed = await trackedChanges(git, from, whitespace);
    files = [...committed, ...untracked].toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  } else if (options.ignoreWhitespace) {
    const numstat = parseNumstat(
      (await git(["diff", "-M", "--numstat", "-z", "--ignore-all-space", from, "--"])).stdout,
    );
    const counts = new Map(numstat.map((entry) => [entry.path, entry]));
    files = files.map((file) =>
      file.status === "untracked"
        ? file
        : {
            ...file,
            insertions: counts.get(file.path)?.insertions ?? 0,
            deletions: counts.get(file.path)?.deletions ?? 0,
          },
    );
  }
  return {
    baseRef,
    headRef: options.scope === "branch" ? (local.head.branch ?? "HEAD") : null,
    patch,
    truncated,
    files,
  };
}
