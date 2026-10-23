// Checkpoints of a working tree as private commits, as T3 Code writes them (MIT, see
// THIRD_PARTY_NOTICES.md): apps/server/src/vcs/GitVcsDriver.ts (captureCheckpoint,
// hasCheckpointRef, restoreCheckpoint, diffCheckpoints, listAuthoredPaths,
// deleteCheckpointRefs) and apps/server/src/checkpointing/Diffs.ts (dropping what
// came from HEAD moving). T3's fast path that reuses the real index and its
// sparse-checkout handling are not ported.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { MAX_PATCH_BYTES, type ChangedFile } from "@jhin/source-control-api";

import { parseNameStatus, parseNumstat, type Git } from "./git.ts";

/** Where a thread's checkpoints live: `0` before its first turn, `N` after turn `N` (D243). */
export const checkpointRef = (threadId: string, turn: number) =>
  `refs/jhin/checkpoints/${threadId}/${turn}`;

/** Every checkpoint ref of a thread lives under this prefix. */
export const checkpointPrefix = (threadId: string) => `refs/jhin/checkpoints/${threadId}/`;

const IDENTITY = {
  GIT_AUTHOR_NAME: "Jhin",
  GIT_AUTHOR_EMAIL: "jhin@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Jhin",
  GIT_COMMITTER_EMAIL: "jhin@users.noreply.github.com",
};

/**
 * Settings of every command writing the scratch index. `core.splitIndex` governs
 * every index git writes, so an unguarded write to the scratch index could expire
 * the shared index the real `.git/index` still uses (T3's comment).
 */
const INDEX_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "sparse.expectFilesOutsideOfPatterns=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
];

/** Writes that survive an unclean stop: no zero-byte refs under `refs/jhin/`. */
const DURABLE = ["-c", "core.fsync=objects,reference", "-c", "core.fsyncMethod=fsync"];

const headExists = async (git: Git) =>
  (await git(["rev-parse", "--verify", "--quiet", "HEAD"], { ok: [0, 1, 128] })).code === 0;

/**
 * Writes the whole working tree of `git`'s directory (untracked files in,
 * ignored ones out) as a tree object through a scratch index, and returns its
 * oid: the real index, `HEAD` and the branch are never touched. Two working
 * trees with the same content have the same oid, committed or not.
 */
export async function writeWorkingTree(
  git: Git,
  commonDir: string,
  exclude: readonly string[] = [],
): Promise<string> {
  const index = Path.join(commonDir, `jhin-checkpoint-index-${Crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (await headExists(git)) await git([...INDEX_CONFIG, "read-tree", "HEAD"], { env });
    // An excluded folder is left out whole, committed or not, so neither its
    // edits nor its commits change the tree.
    if (exclude.length > 0) {
      const folders = exclude.map((folder) => `:(glob)**/${folder}/**`);
      await git(
        [...INDEX_CONFIG, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...folders],
        { env },
      );
    }
    const excluded = exclude.map((folder) => `:(exclude,glob)**/${folder}/**`);
    await git([...INDEX_CONFIG, ...DURABLE, "add", "-A", "--", ".", ...excluded], { env });
    const tree = (await git([...INDEX_CONFIG, ...DURABLE, "write-tree"], { env })).stdout.trim();
    if (tree === "") throw new Error("git write-tree returned an empty tree oid.");
    return tree;
  } finally {
    await Promise.all([Fs.rm(index, { force: true }), Fs.rm(`${index}.lock`, { force: true })]);
  }
}

/** Commits the whole working tree (`writeWorkingTree`) under `ref`. */
export async function captureCheckpoint(git: Git, commonDir: string, ref: string): Promise<void> {
  const tree = await writeWorkingTree(git, commonDir);
  const head = await headExists(git);
  // HEAD is the parent, so how HEAD moved between two checkpoints can be read (authoredPaths).
  const commit = (
    await git(
      [
        ...DURABLE,
        "commit-tree",
        tree,
        ...(head ? ["-p", "HEAD"] : []),
        "-m",
        `jhin checkpoint ref=${ref}`,
      ],
      { env: IDENTITY },
    )
  ).stdout.trim();
  await git([...DURABLE, "update-ref", ref, commit], { env: IDENTITY });
}

export async function hasCheckpoint(git: Git, ref: string): Promise<boolean> {
  const found = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    ok: [0, 1, 128],
  });
  return found.code === 0;
}

export async function deleteCheckpoints(git: Git, refs: readonly string[]): Promise<void> {
  for (const ref of refs) await git(["update-ref", "-d", ref], { ok: [0, 1, 128] });
}

/** The checkpoint refs under `prefix`. */
export async function listCheckpoints(git: Git, prefix: string): Promise<string[]> {
  const listed = await git(["for-each-ref", "--format=%(refname)", prefix]);
  return listed.stdout.split("\n").filter((line) => line !== "");
}

/** The parent (the `HEAD` it was taken on) and the time of a checkpoint commit. */
async function parentsAndTimes(git: Git, refs: readonly string[]) {
  const log = await git([
    "log",
    "--no-walk=unsorted",
    "--format=%P %ct",
    ...refs.map((ref) => `${ref}^{commit}`),
  ]);
  return log.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      // A checkpoint taken before the first commit has no parent: the line starts with " ".
      const [parent = "", time] = line.split(" ");
      return { parent: parent === "" ? undefined : parent, time };
    });
}

const namesOf = async (git: Git, args: readonly string[]) =>
  (
    await git([
      ...args.slice(0, 1),
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      ...args.slice(1),
    ])
  ).stdout
    .split("\0")
    .filter((name) => name !== "");

/**
 * The paths the turn between two checkpoints changed itself; `null` when `HEAD`
 * did not move (every changed path is the turn's). When it moved (a pull, a
 * rebase, a checkout), the files that came with the move are not.
 */
async function authoredPaths(
  git: Git,
  from: string,
  to: string,
): Promise<ReadonlySet<string> | null> {
  const [start, end] = await parentsAndTimes(git, [from, to]);
  const startHead = start?.parent;
  const endHead = end?.parent;
  if (startHead === undefined || endHead === undefined || startHead === endHead) return null;
  const lists = await Promise.all([
    // What was dirty at the start and at the end is the turn's (or the user's) own.
    namesOf(git, ["diff", startHead, `${from}^{commit}`]),
    namesOf(git, ["diff", endHead, `${to}^{commit}`]),
    // Commits made during the turn (after the start checkpoint) are its own too.
    namesOf(git, ["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
    namesOf(git, [
      "log",
      "--format=",
      "--diff-merges=remerge",
      `--since=@${start!.time}`,
      `${startHead}..${endHead}`,
    ]),
  ]);
  return new Set(lists.flat());
}

const rangeArgs = (from: string, to: string, ignoreWhitespace: boolean) => [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
  `${from}^{commit}`,
  `${to}^{commit}`,
];

/** The files changed between two checkpoints, without those that came from HEAD moving. */
export async function checkpointFiles(
  git: Git,
  from: string,
  to: string,
  options: { ignoreWhitespace: boolean },
): Promise<ChangedFile[]> {
  const range = rangeArgs(from, to, options.ignoreWhitespace);
  const [numstat, names, authored] = await Promise.all([
    git(["diff", "-M", "--numstat", "-z", ...range]),
    git(["diff", "-M", "--name-status", "-z", ...range]),
    authoredPaths(git, from, to),
  ]);
  const statuses = new Map(
    parseNameStatus(names.stdout).map((entry) => [entry.path, entry.status]),
  );
  return parseNumstat(numstat.stdout)
    .filter(
      (entry) =>
        authored === null ||
        authored.has(entry.path) ||
        (entry.previousPath !== undefined && authored.has(entry.previousPath)),
    )
    .map((entry): ChangedFile => ({
      path: entry.path,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      status:
        statuses.get(entry.path) ?? (entry.previousPath === undefined ? "modified" : "renamed"),
      insertions: entry.insertions,
      deletions: entry.deletions,
      binary: entry.binary,
    }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The unified diff between two checkpoints, limited to `files` (repository-relative paths). */
export async function checkpointPatch(
  git: Git,
  from: string,
  to: string,
  files: readonly ChangedFile[],
  options: { ignoreWhitespace: boolean },
): Promise<{ patch: string; truncated: boolean }> {
  if (files.length === 0) return { patch: "", truncated: false };
  const paths = files.flatMap((file) =>
    file.previousPath === undefined ? [file.path] : [file.previousPath, file.path],
  );
  const diff = await git(
    [
      "diff",
      "-M",
      ...rangeArgs(from, to, options.ignoreWhitespace),
      "--",
      ...paths.map((path) => `:(top,literal)${path}`),
    ],
    { maxBytes: MAX_PATCH_BYTES },
  );
  return { patch: diff.stdout, truncated: diff.truncated };
}

/**
 * Puts the checkpoint's files back into `git`'s directory: the working tree
 * becomes the checkpoint's, the index `HEAD`'s; `HEAD`, the branch and ignored
 * files stay. False when there is no such checkpoint.
 */
export async function restoreCheckpoint(git: Git, cwd: string, ref: string): Promise<boolean> {
  const found = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    ok: [0, 1, 128],
  });
  const commit = found.stdout.trim();
  if (found.code !== 0 || commit === "") return false;
  const tracked = await git(["ls-files", "--cached", `--with-tree=${commit}`, "-z", "--", "."]);
  if (tracked.stdout !== "") {
    await git(["restore", `--source=${commit}`, "--worktree", "--staged", "--", "."]);
  }
  // Restoring may remove the directory itself when it is a folder inside the repository.
  await Fs.mkdir(cwd, { recursive: true });
  await git(["clean", "-fd", "--", "."]);
  await Fs.mkdir(cwd, { recursive: true });
  if (await headExists(git)) await git(["reset", "--quiet", "--", "."]);
  return true;
}
