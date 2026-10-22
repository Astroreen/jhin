import * as Fs from "node:fs";
import * as Path from "node:path";

import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { judge, type CleanupCandidate, type WorktreeCleanupRules } from "../src/cleanup.ts";
import { createGit } from "../src/git.ts";
import { memoryStoragePlugin } from "@jhin/testing";

import { git, node, repository, temp, type Node } from "./support.ts";

interface Report {
  entries: { path: string; threadId?: string; outcome: string; reason: string }[];
  counts: { removed: number; kept: number; failed: number };
}

const removed = (threadId: string) => (event: StoredEvent) =>
  event.type === "source-control.thread.removed" &&
  (event.payload as { threadId: string }).threadId === threadId;

async function worktreeThread(sc: Node, projectId: string) {
  const thread = await sc.client.call<{ id: string; worktreePath: string }>("threads.create", {
    projectId,
    workspace: { type: "worktree", baseRef: "main" },
  });
  await sc.until(
    (event) =>
      event.type === "source-control.thread.changed" &&
      (event.payload as { threadId: string }).threadId === thread.id,
  );
  return thread;
}

/** Sends a message and resolves once the thread's turn ended. */
async function firstTurn(sc: Node, threadId: string) {
  const ended = sc.next(
    "threads",
    (event) =>
      event.type === "threads.thread.updated" &&
      (event.payload as { id: string; lastTurn?: { status: string } }).id === threadId &&
      ["completed", "failed", "interrupted"].includes(
        (event.payload as { lastTurn?: { status: string } }).lastTurn?.status ?? "",
      ),
  );
  await sc.client.call("threads.send", { threadId, text: "hello" });
  await ended;
}

const cleanup = (sc: Node) => sc.client.call<Report>("git.worktree.cleanup", {});

describe("jhin.source-control: worktree cleanup (D1128–D1130)", () => {
  it("leaves a worktree deleted without the rule to the user's choice, even once the rule is on", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await worktreeThread(sc, projectId);
    expect(
      (await sc.client.call<{ cleanupOnDelete: boolean }>("git.worktree.list", { projectId }))
        .cleanupOnDelete,
    ).toBe(false);

    // Deleted with the rule off: the user answered D255's question then.
    await sc.client.call("threads.delete", { threadId: thread.id });
    await sc.until(removed(thread.id));
    expect(await cleanup(sc)).toEqual({ entries: [], counts: { removed: 0, kept: 0, failed: 0 } });

    sc.configure({ worktreeCleanup: { onDelete: true } });
    expect(
      (await sc.client.call<{ cleanupOnDelete: boolean }>("git.worktree.list", { projectId }))
        .cleanupOnDelete,
    ).toBe(true);
    expect((await cleanup(sc)).entries).toEqual([]);
    expect(Fs.existsSync(thread.worktreePath)).toBe(true);
  });

  it("sweeps once a thread is deleted while onDelete is on, with nobody asking", async () => {
    const dir = repository();
    const sc = await node({ watch: false, worktreeCleanup: { onDelete: true } });
    const projectId = await sc.project(dir);
    const thread = await worktreeThread(sc, projectId);
    const branch = git(thread.worktreePath, "branch", "--show-current").trim();
    const swept = sc.logged("removed a worktree");
    await sc.client.call("threads.delete", { threadId: thread.id });
    await swept;
    expect(Fs.existsSync(thread.worktreePath)).toBe(false);
    // Its branch stays.
    expect(git(dir, "branch", "--list", branch).trim()).toBe(branch);
    // Decided once: a later sweep has nothing left to look at.
    expect((await cleanup(sc)).entries).toEqual([]);
  });

  it("sweeps when the node starts, once every plugin is up, with nobody asking", async () => {
    const dir = repository();
    const data = temp("jhin-sc-restart-");
    const storage = memoryStoragePlugin();
    const before = await node({ watch: false }, { data, storage });
    const projectId = await before.project(dir);
    const thread = await worktreeThread(before, projectId);
    await firstTurn(before, thread.id);
    await before.stop();

    // Started again with a rule that removes it: the startup sweep reads the
    // projects and threads, so it runs only once the threads plugin answers.
    const after = await node(
      { watch: false, worktreeCleanup: { unchanged: true } },
      { data, storage },
    );
    await after.loggedSinceStart("removed a worktree");
    expect(Fs.existsSync(thread.worktreePath)).toBe(false);
  });

  it("sweeps when its rules change, with nobody asking", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await worktreeThread(sc, projectId);
    await firstTurn(sc, thread.id);
    // New rules apply at once, as T3 sweeps when its settings change.
    const swept = sc.logged("removed a worktree");
    sc.configure({ worktreeCleanup: { unchanged: true } });
    await swept;
    expect(Fs.existsSync(thread.worktreePath)).toBe(false);
  });

  it("keeps local changes as keepWhen counts them", async () => {
    const dir = repository();
    const sc = await node({ watch: false, worktreeCleanup: { onDelete: true } });
    const projectId = await sc.project(dir);
    const thread = await worktreeThread(sc, projectId);
    Fs.writeFileSync(Path.join(thread.worktreePath, "notes.txt"), "draft\n");
    // Deleted while the rule is on: the sweep that follows keeps the untracked file.
    await sc.client.call("threads.delete", { threadId: thread.id });
    await sc.until(removed(thread.id));
    expect((await cleanup(sc)).entries).toMatchObject([
      { outcome: "kept", reason: "Has uncommitted changes (1 file)." },
    ]);
    expect(Fs.existsSync(thread.worktreePath)).toBe(true);

    // Edited tracked files only: an untracked one is no reason to keep it.
    const swept = sc.logged("removed a worktree");
    sc.configure({ worktreeCleanup: { onDelete: true, keepWhen: "tracked-changes" } });
    await swept;
    expect(Fs.existsSync(thread.worktreePath)).toBe(false);
  });

  it("removes an unchanged worktree of a live thread, which its next turn makes again", async () => {
    const dir = repository();
    const sc = await node({ watch: false, worktreeCleanup: { unchanged: true } });
    const projectId = await sc.project(dir);
    const unchanged = await worktreeThread(sc, projectId);
    const ahead = await worktreeThread(sc, projectId);
    git(ahead.worktreePath, "commit", "--quiet", "--allow-empty", "-m", "ahead");
    // Both have had their first turn: a thread still to start keeps its worktree.
    for (const thread of [unchanged, ahead]) await firstTurn(sc, thread.id);

    const report = await cleanup(sc);
    expect(report.entries.toSorted((a, b) => a.reason.localeCompare(b.reason))).toEqual([
      {
        path: ahead.worktreePath,
        threadId: ahead.id,
        outcome: "kept",
        reason: "Has commits beyond the default branch.",
      },
      {
        path: unchanged.worktreePath,
        threadId: unchanged.id,
        outcome: "removed",
        reason: "No commits beyond the default branch.",
      },
    ]);
    expect(Fs.existsSync(unchanged.worktreePath)).toBe(false);
    // The thread keeps its worktree's path and branch: its next turn checks it out again (D256).
    await sc.client.call("threads.send", { threadId: unchanged.id, text: "/write a.txt back" });
    await sc.until(
      (event) =>
        event.type === "source-control.worktree.changed" &&
        (event.payload as { worktreePath: string; workingTree: { fileCount: number } })
          .worktreePath === unchanged.worktreePath &&
        (event.payload as { workingTree: { fileCount: number } }).workingTree.fileCount === 1,
    );
    expect(Fs.readFileSync(Path.join(unchanged.worktreePath, "a.txt"), "utf8")).toBe("back\n");
  });
});

describe("worktree cleanup decisions (D1129, T3's cleanWorktrees)", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-10-22T12:00:00Z");
  const off: WorktreeCleanupRules = {
    onDelete: false,
    afterDays: null,
    settledAfterDays: null,
    onMerge: false,
    unchanged: false,
    keepWhen: "uncommitted-changes",
  };

  /** A project on main with a worktree on `feature`, one commit ahead of main when `ahead`. */
  function worktree(ahead: boolean) {
    const dir = repository();
    const path = Path.join(temp("jhin-sc-wt-"), "feature");
    git(dir, "worktree", "add", "--quiet", "-b", "feature", path);
    if (ahead) git(path, "commit", "--quiet", "--allow-empty", "-m", "ahead");
    return { dir, path };
  }

  const decide = (
    where: { dir: string; path: string },
    rules: Partial<WorktreeCleanupRules>,
    candidate: Partial<CleanupCandidate> = {},
    hasTerminal = false,
  ) =>
    judge(
      {
        path: where.path,
        projectId: "p",
        projectPath: where.dir,
        branch: "feature",
        threadId: "t",
        deleted: false,
        mergedInto: [],
        threads: [{ id: "t", running: false, activeAt: NOW - 5 * DAY }],
        ...candidate,
      },
      { ...off, ...rules },
      { now: NOW, git: (cwd) => createGit("git", cwd), hasTerminal: () => hasTerminal },
    );

  it("removes after the inactive days, and says how far it got before", async () => {
    const where = worktree(true);
    expect(await decide(where, { afterDays: 3 })).toEqual({ remove: "Inactive for 5 days." });
    expect(await decide(where, { afterDays: 7 })).toEqual({ keep: "Inactive for 5 of 7 days." });
  });

  it("removes a settled one at the next cleanup with 0 days, and keeps an unsettled one", async () => {
    const where = worktree(true);
    const settled = {
      threads: [{ id: "t", running: false, activeAt: NOW - DAY, settledAt: NOW - DAY }],
    };
    expect(await decide(where, { settledAfterDays: 0 }, settled)).toEqual({
      remove: "Settled for 1 days.",
    });
    expect(await decide(where, { settledAfterDays: 0 })).toEqual({ keep: "Not settled." });
  });

  it("removes a merged one only into the default branch, or with its commits there", async () => {
    const where = worktree(true);
    expect(await decide(where, { onMerge: true }, { mergedInto: ["main"] })).toEqual({
      remove: "Pull request was merged.",
    });
    expect(await decide(where, { onMerge: true }, { mergedInto: ["release"] })).toEqual({
      keep: "Not merged.",
    });
    expect(await decide(where, { onMerge: true })).toEqual({ keep: "Not merged." });
    // Its commits in the default branch: any merged pull request of the branch will do.
    const integrated = worktree(false);
    expect(await decide(integrated, { onMerge: true }, { mergedInto: ["release"] })).toEqual({
      remove: "Pull request was merged.",
    });
  });

  it("keeps one shared, running, with an open terminal, or deleted without the rule", async () => {
    const where = worktree(false);
    const two = {
      threads: [
        { id: "a", running: false, activeAt: NOW },
        { id: "b", running: false, activeAt: NOW },
      ],
    };
    expect(await decide(where, { unchanged: true }, two)).toEqual({ keep: "Shared by 2 threads." });
    expect(
      await decide(
        where,
        { unchanged: true },
        { threads: [{ id: "t", running: true, activeAt: NOW }] },
      ),
    ).toEqual({ keep: "Thread is running or has pending work." });
    expect(await decide(where, { unchanged: true }, {}, true)).toEqual({ keep: "Open terminal." });
    expect(await decide(where, { unchanged: true }, { deleted: true, threads: [] })).toEqual({
      keep: "No rules apply.",
    });
  });

  it("says no rule applies to a live thread under the delete rule alone", async () => {
    expect(await decide(worktree(true), { onDelete: true })).toEqual({ keep: "No rules apply." });
  });

  it("counts ignored files as local ones, but node_modules, with any local files", async () => {
    const where = worktree(false);
    Fs.writeFileSync(Path.join(where.path, ".gitignore"), "");
    git(where.path, "add", ".gitignore");
    git(where.path, "commit", "--quiet", "-m", "ignore");
    git(where.dir, "merge", "--quiet", "--ff-only", "feature");
    Fs.writeFileSync(Path.join(where.path, ".gitignore"), "node_modules/\n.env\n");
    git(where.path, "commit", "--quiet", "-am", "ignore more");
    git(where.dir, "merge", "--quiet", "--ff-only", "feature");
    Fs.mkdirSync(Path.join(where.path, "node_modules"));
    Fs.writeFileSync(Path.join(where.path, "node_modules", "x.js"), "");
    expect(await decide(where, { unchanged: true, keepWhen: "any-local-files" })).toEqual({
      remove: "No commits beyond the default branch.",
    });
    Fs.writeFileSync(Path.join(where.path, ".env"), "SECRET=1\n");
    expect(await decide(where, { unchanged: true, keepWhen: "any-local-files" })).toEqual({
      keep: "Has ignored files (.env).",
    });
    // The default keeps edits and untracked files only: an ignored .env goes.
    expect(await decide(where, { unchanged: true })).toEqual({
      remove: "No commits beyond the default branch.",
    });
  });

  it("keeps a fresh worktree whose thread has not had its first turn", async () => {
    expect(
      await decide(
        worktree(false),
        { unchanged: true },
        { threads: [{ id: "t", running: false, started: false, activeAt: NOW }] },
      ),
    ).toEqual({ keep: "Thread has not started yet." });
  });
});
