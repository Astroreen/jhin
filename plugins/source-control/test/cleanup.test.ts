import * as Fs from "node:fs";
import * as Path from "node:path";

import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { judge, type CleanupCandidate, type WorktreeCleanupRules } from "../src/cleanup.ts";
import { createGit } from "../src/git.ts";
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

const cleanup = (sc: Node) => sc.client.call<Report>("git.worktree.cleanup", {});

describe("jhin.source-control: worktree cleanup (D1128–D1130)", () => {
  it("removes a deleted thread's worktree only under onDelete, keeping its branch", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await worktreeThread(sc, projectId);
    const branch = git(thread.worktreePath, "branch", "--show-current").trim();
    expect(
      (await sc.client.call<{ cleanupOnDelete: boolean }>("git.worktree.list", { projectId }))
        .cleanupOnDelete,
    ).toBe(false);

    await sc.client.call("threads.delete", { threadId: thread.id });
    await sc.until(removed(thread.id));
    // Every rule off: nothing is looked at.
    expect(await cleanup(sc)).toEqual({ entries: [], counts: { removed: 0, kept: 0, failed: 0 } });

    // New rules apply at once: their sweep removes it.
    const swept = sc.logged("removed a worktree");
    sc.configure({ worktreeCleanup: { onDelete: true } });
    await swept;
    expect(
      (await sc.client.call<{ cleanupOnDelete: boolean }>("git.worktree.list", { projectId }))
        .cleanupOnDelete,
    ).toBe(true);
    expect(Fs.existsSync(thread.worktreePath)).toBe(false);
    expect(git(dir, "branch", "--list", branch).trim()).toBe(branch);
    // Decided once: a later sweep has nothing left to look at.
    expect((await cleanup(sc)).entries).toEqual([]);
  });

  it("sweeps once a thread is deleted while onDelete is on, with nobody asking", async () => {
    const dir = repository();
    const sc = await node({ watch: false, worktreeCleanup: { onDelete: true } });
    const projectId = await sc.project(dir);
    const thread = await worktreeThread(sc, projectId);
    const swept = sc.logged("removed a worktree");
    await sc.client.call("threads.delete", { threadId: thread.id });
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
});
