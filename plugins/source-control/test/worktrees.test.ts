import * as Fs from "node:fs";
import * as Path from "node:path";

import type {
  CreatedWorktree,
  ThreadBranch,
  TurnCheckpoint,
  Worktree,
  WorktreeStatus,
} from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { parseWorktreeList } from "../src/worktrees.ts";
import { git, node, repository, temp, write, type Node } from "./support.ts";

interface Thread {
  id: string;
  projectId: string;
  worktreePath?: string;
}

/**
 * Sends a message and waits until the thread's record says the turn ended: the
 * thread takes the next message from then on.
 */
async function turn(sc: Node, threadId: string, text: string) {
  const seen: { turnId: string; status: string }[] = [];
  let wanted: string | undefined;
  let done!: () => void;
  const ended = new Promise<void>((resolve) => (done = resolve));
  const subscription = sc.client.subscribe("threads", {}, (event) => {
    const record = event.payload as { id?: string; lastTurn?: { turnId: string; status: string } };
    if (event.type !== "threads.thread.updated" || record.id !== threadId || !record.lastTurn)
      return;
    seen.push(record.lastTurn);
    if (record.lastTurn.turnId === wanted && record.lastTurn.status !== "running") done();
  });
  const { turnId } = await sc.client.call<{ turnId: string }>("threads.send", { threadId, text });
  wanted = turnId;
  if (seen.some((last) => last.turnId === turnId && last.status !== "running")) done();
  await ended;
  subscription.dispose();
  return turnId;
}

const branchOf = (threadId: string, branch: string) => (event: StoredEvent) =>
  event.type === "source-control.thread.changed" &&
  (event.payload as ThreadBranch).threadId === threadId &&
  (event.payload as ThreadBranch).branch === branch;

const worktreeEvent = (path: string) => (event: StoredEvent) =>
  event.type === "source-control.worktree.changed" &&
  (event.payload as WorktreeStatus).worktreePath === path;

describe("jhin.source-control: worktrees", () => {
  it("makes a new thread's worktree, runs its turns there and follows its status", async () => {
    const dir = repository();
    const data = temp("jhin-sc-home-");
    const sc = await node({ watch: false }, { data });
    const projectId = await sc.project(dir);

    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    const path = thread.worktreePath!;
    // <home>/worktrees/<repository>/<branch, "/" as "-">, on a temporary jhin/<hex> branch.
    expect(Path.dirname(path)).toBe(Path.join(data, "worktrees", Path.basename(dir)));
    expect(Path.basename(path)).toMatch(/^jhin-[0-9a-f]{8}$/);
    const branch = git(path, "branch", "--show-current").trim();
    expect(branch).toMatch(/^jhin\/[0-9a-f]{8}$/);
    await sc.until(branchOf(thread.id, branch));

    await turn(sc, thread.id, "/write notes.txt in the worktree");
    expect(Fs.readFileSync(Path.join(path, "notes.txt"), "utf8")).toBe("in the worktree\n");
    expect(Fs.existsSync(Path.join(dir, "notes.txt"))).toBe(false);
    const status = (
      await sc.until(
        (event) =>
          worktreeEvent(path)(event) &&
          (event.payload as WorktreeStatus).workingTree.fileCount === 1,
      )
    ).payload as WorktreeStatus;
    expect(status).toMatchObject({ projectId, branch, worktreePath: path });

    // The project's own status is untouched; its thread's diff is the worktree's.
    const snapshot = await sc.status();
    expect(
      snapshot.projects.find((item) => item.projectId === projectId)?.workingTree.fileCount,
    ).toBe(0);
    expect(snapshot.worktrees?.map((item) => item.worktreePath)).toEqual([path]);
    const diff = await sc.client.call<{ files: { path: string }[] }>("git.diff", {
      threadId: thread.id,
    });
    expect(diff.files.map((file) => file.path)).toEqual(["notes.txt"]);
    const threadStatus = await sc.client.call<{ checkedOut: boolean; status: { branch: string } }>(
      "git.thread.status",
      { threadId: thread.id },
    );
    expect(threadStatus).toMatchObject({ checkedOut: true, status: { branch } });

    const { worktrees } = await sc.client.call<{ worktrees: Worktree[] }>("git.worktree.list", {
      projectId,
    });
    expect(worktrees).toEqual([
      { path: dir, branch: "main", main: true, managed: false, threadIds: [] },
      { path, branch, main: false, managed: true, threadIds: [thread.id] },
    ]);
  });

  it("starts from origin when asked, refuses an existing branch, and takes an existing worktree", async () => {
    const origin = repository();
    const dir = temp("jhin-sc-clone-");
    git(dir, "clone", "--quiet", origin, ".");
    // origin moves on after the clone.
    write(origin, "later.txt", "later\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "later");
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);

    const fromOrigin = await sc.client.call<CreatedWorktree>("git.worktree.create", {
      projectId,
      baseRef: "main",
      branch: "feature/from-origin",
      startFromOrigin: true,
    });
    expect(fromOrigin).toMatchObject({
      branch: "feature/from-origin",
      baseRef: "main",
      startRef: "refs/remotes/origin/main",
    });
    expect(Path.basename(fromOrigin.path)).toBe("feature-from-origin");
    expect(Fs.existsSync(Path.join(fromOrigin.path, "later.txt"))).toBe(true);
    const local = await sc.client.call<CreatedWorktree>("git.worktree.create", {
      projectId,
      baseRef: "main",
      branch: "feature/local",
    });
    expect(Fs.existsSync(Path.join(local.path, "later.txt"))).toBe(false);

    await expect(
      sc.client.call("git.worktree.create", {
        projectId,
        baseRef: "main",
        branch: "feature/local",
      }),
    ).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
    await expect(
      sc.client.call("git.worktree.create", { projectId, baseRef: "nope" }),
    ).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });

    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "existing_worktree", worktreePath: local.path },
    });
    expect(thread.worktreePath).toBe(local.path);
    await sc.until(branchOf(thread.id, "feature/local"));

    await sc.client.call("git.worktree.remove", { projectId, path: fromOrigin.path });
    expect(Fs.existsSync(fromOrigin.path)).toBe(false);
    await expect(
      sc.client.call("git.worktree.remove", { projectId, path: dir }),
    ).rejects.toMatchObject({ code: "WORKTREE_INVALID" });
  });

  it("hands a thread over to a new worktree once, from the branch checked out", async () => {
    const dir = repository();
    git(dir, "switch", "--quiet", "--create", "feature/base");
    write(dir, "base.txt", "base\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "base");
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", { projectId });

    const created = await sc.client.call<CreatedWorktree>("git.worktree.handoff", {
      threadId: thread.id,
      branch: "feature/handed",
    });
    expect(created).toMatchObject({ branch: "feature/handed", baseRef: "feature/base" });
    expect(Fs.existsSync(Path.join(created.path, "base.txt"))).toBe(true);
    const { thread: moved } = await sc.client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(moved.worktreePath).toBe(created.path);
    await sc.until(branchOf(thread.id, "feature/handed"));

    await turn(sc, thread.id, "/write handed.txt here");
    expect(Fs.existsSync(Path.join(created.path, "handed.txt"))).toBe(true);
    await expect(
      sc.client.call("git.worktree.handoff", { threadId: thread.id }),
    ).rejects.toMatchObject({
      code: "ALREADY_IN_WORKTREE",
      message: `Thread '${thread.id}' is already attached to worktree '${created.path}'.`,
    });

    // A detached HEAD names no base.
    git(dir, "switch", "--quiet", "--detach");
    const other = await sc.client.call<Thread>("threads.create", { projectId });
    await expect(sc.client.call("git.worktree.handoff", { threadId: other.id })).rejects.toThrow(
      "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
    );
  });

  it("makes a missing worktree again when its thread's next turn starts", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main", branch: "feature/again" },
    });
    await sc.until(branchOf(thread.id, "feature/again"));
    Fs.rmSync(thread.worktreePath!, { recursive: true, force: true });

    await turn(sc, thread.id, "/write back.txt again");
    expect(Fs.readFileSync(Path.join(thread.worktreePath!, "back.txt"), "utf8")).toBe("again\n");
    expect(git(thread.worktreePath!, "branch", "--show-current").trim()).toBe("feature/again");
  });

  it("names a temporary branch from the thread's first message, beside a taken name", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    // The fake agent echoes the writer's prompt: the message's JSON is its answer.
    const message = '{"branch": "Fix the Login error"}';
    const first = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    await turn(sc, first.id, message);
    await sc.until(branchOf(first.id, "jhin/fix-the-login-error"));
    expect(git(first.worktreePath!, "branch", "--show-current").trim()).toBe(
      "jhin/fix-the-login-error",
    );

    const second = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    await turn(sc, second.id, message);
    await sc.until(branchOf(second.id, "jhin/fix-the-login-error-1"));
    // The folder keeps its temporary name, as in T3.
    expect(Path.basename(second.worktreePath!)).toMatch(/^jhin-[0-9a-f]{8}$/);
  });

  it("lets go of a worktree no thread works in any more", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    await sc.until(worktreeEvent(thread.worktreePath!));
    await sc.client.call("threads.delete", { threadId: thread.id });
    await sc.until(
      (event) =>
        event.type === "source-control.worktree.removed" &&
        (event.payload as { worktreePath: string }).worktreePath === thread.worktreePath,
    );
    expect((await sc.status()).worktrees).toEqual([]);
    // The worktree stays on disk: deleting it is the user's choice (D255).
    expect(Fs.existsSync(thread.worktreePath!)).toBe(true);
  });
});

describe("jhin.source-control: worktrees that go wrong", () => {
  const listed = (dir: string) =>
    git(dir, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));

  it("removes the worktree again when its thread is not created", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const first = await sc.client.call<Thread>("threads.create", { projectId, threadId: "t-once" });
    await sc.client.call("threads.delete", { threadId: first.id });
    // The id existed: the thread cannot be created again, so its worktree goes.
    await expect(
      sc.client.call("threads.create", {
        projectId,
        threadId: "t-once",
        workspace: { type: "worktree", baseRef: "main", branch: "feature/orphan" },
      }),
    ).rejects.toMatchObject({ code: "THREAD_EXISTS" });
    expect(listed(dir)).toHaveLength(1);
    expect(git(dir, "branch", "--list", "feature/orphan")).toBe("");
  });

  it("takes only a worktree of the project, on the branch named", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const other = temp("jhin-sc-other-");
    await expect(
      sc.client.call("threads.create", {
        projectId,
        workspace: { type: "existing_worktree", worktreePath: other },
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    const made = await sc.client.call<CreatedWorktree>("git.worktree.create", {
      projectId,
      baseRef: "main",
      branch: "feature/here",
    });
    await expect(
      sc.client.call("threads.create", {
        projectId,
        workspace: { type: "existing_worktree", worktreePath: made.path, branch: "main" },
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "existing_worktree", worktreePath: made.path, branch: "feature/here" },
    });
    expect(thread.worktreePath).toBe(made.path);
  });

  it("removes only a listed worktree no thread works in", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main", branch: "feature/busy" },
    });
    await sc.until(branchOf(thread.id, "feature/busy"));
    await expect(
      sc.client.call("git.worktree.remove", { projectId, path: thread.worktreePath, force: true }),
    ).rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
    await expect(
      sc.client.call("git.worktree.remove", { projectId, path: temp("jhin-sc-nowhere-") }),
    ).rejects.toMatchObject({ code: "WORKTREE_INVALID" });
    expect(Fs.existsSync(thread.worktreePath!)).toBe(true);
  });

  it("knows a worktree named through a link as the same one", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const made = await sc.client.call<CreatedWorktree>("git.worktree.create", {
      projectId,
      baseRef: "main",
      branch: "feature/linked",
    });
    const link = Path.join(temp("jhin-sc-link-"), "wt");
    Fs.symlinkSync(made.path, link);
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "existing_worktree", worktreePath: link },
    });
    const { worktrees } = await sc.client.call<{ worktrees: Worktree[] }>("git.worktree.list", {
      projectId,
    });
    expect(worktrees.find((entry) => entry.branch === "feature/linked")?.threadIds).toEqual([
      thread.id,
    ]);
    await expect(
      sc.client.call("git.worktree.remove", { projectId, path: link, force: true }),
    ).rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
  });

  it("refuses a branch whose folder another branch took, and says when origin had no base", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    await sc.client.call("git.worktree.create", { projectId, baseRef: "main", branch: "a/b" });
    await expect(
      sc.client.call("git.worktree.create", { projectId, baseRef: "main", branch: "a-b" }),
    ).rejects.toMatchObject({ code: "WORKTREE_INVALID" });
    // No origin at all: the local base, and the answer says so.
    const local = await sc.client.call<CreatedWorktree>("git.worktree.create", {
      projectId,
      baseRef: "main",
      branch: "feature/no-origin",
      startFromOrigin: true,
    });
    expect(local).toMatchObject({ startRef: "main", startedFromOrigin: false });
  });

  it("hands a thread over once when two handoffs race", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", { projectId });
    const results = await Promise.allSettled([
      sc.client.call("git.worktree.handoff", { threadId: thread.id, branch: "feature/one" }),
      sc.client.call("git.worktree.handoff", { threadId: thread.id, branch: "feature/two" }),
    ]);
    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({ code: "ALREADY_IN_WORKTREE" });
    expect(listed(dir)).toHaveLength(2);
  });

  it("fails the turn saying why when a missing worktree cannot be made again", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main", branch: "feature/lost" },
    });
    await sc.until(branchOf(thread.id, "feature/lost"));
    Fs.rmSync(thread.worktreePath!, { recursive: true, force: true });
    git(dir, "worktree", "prune");
    git(dir, "branch", "-D", "feature/lost");
    await expect(
      sc.client.call("threads.send", { threadId: thread.id, text: "hi" }),
    ).rejects.toMatchObject({ code: "WORKTREE_MISSING" });
  });
});

describe("jhin.source-control: reverting to a turn", () => {
  const checkpointOf = (threadId: string, count: number, status: string) => (event: StoredEvent) =>
    event.type === "source-control.checkpoint.changed" &&
    (event.payload as TurnCheckpoint).threadId === threadId &&
    (event.payload as TurnCheckpoint).turn === count &&
    (event.payload as TurnCheckpoint).status === status;
  /** A thread's checkpoints as its node lists them now. */
  const turnIds = async (sc: Node, threadId: string) =>
    (await sc.client.call<{ checkpoints: TurnCheckpoint[] }>("git.checkpoints", { threadId }))
      .checkpoints;

  it("puts a worktree thread's files back as they were before the message", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main", branch: "feature/revert" },
    });
    const path = thread.worktreePath!;
    await turn(sc, thread.id, "/write kept.txt first");
    const second = await turn(sc, thread.id, "/write dropped.txt second");
    await sc.until(checkpointOf(thread.id, 2, "ready"));

    await sc.client.call("threads.rollback", {
      threadId: thread.id,
      beforeTurnId: second,
      restoreFiles: true,
    });
    expect(Fs.existsSync(Path.join(path, "dropped.txt"))).toBe(false);
    expect(Fs.readFileSync(Path.join(path, "kept.txt"), "utf8")).toBe("first\n");
    // The dropped turn's checkpoint went stale and its ref away; turn 1 is the latest again.
    await sc.until(checkpointOf(thread.id, 2, "stale"));
    expect(
      git(dir, "for-each-ref", "--format=%(refname)", "refs/jhin/").trim().split("\n"),
    ).toEqual([`refs/jhin/checkpoints/${thread.id}/0`, `refs/jhin/checkpoints/${thread.id}/1`]);
    expect((await sc.status()).checkpoints?.map((item) => [item.turn, item.status])).toEqual([
      [1, "ready"],
    ]);
    // The next turn takes the dropped one's place.
    await turn(sc, thread.id, "/write again.txt third");
    // Its record is written before the turn's end is (D241), so it is there now.
    expect((await turnIds(sc, thread.id)).map((item) => [item.turn, item.status])).toEqual([
      [1, "ready"],
      [2, "ready"],
    ]);
    expect((await turnIds(sc, thread.id))[1]?.files.map((file) => file.path)).toEqual([
      "again.txt",
    ]);
  });

  it("refuses to restore a worktree two threads share, or a checkpoint that is gone, dropping nothing", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "worktree", baseRef: "main", branch: "feature/shared" },
    });
    const first = await turn(sc, thread.id, "/write a.txt one");
    await sc.until(checkpointOf(thread.id, 1, "ready"));
    const other = await sc.client.call<Thread>("threads.create", {
      projectId,
      workspace: { type: "existing_worktree", worktreePath: thread.worktreePath! },
    });
    await expect(
      sc.client.call("threads.rollback", {
        threadId: thread.id,
        beforeTurnId: first,
        restoreFiles: true,
      }),
    ).rejects.toThrow("File restore requires an isolated worktree.");
    await sc.client.call("threads.delete", { threadId: other.id });

    git(dir, "update-ref", "-d", `refs/jhin/checkpoints/${thread.id}/0`);
    await expect(
      sc.client.call("threads.rollback", {
        threadId: thread.id,
        beforeTurnId: first,
        restoreFiles: true,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
    expect(Fs.existsSync(Path.join(thread.worktreePath!, "a.txt"))).toBe(true);
    expect(await turnIds(sc, thread.id)).toHaveLength(1);
    const { thread: still } = await sc.client.call<{ thread: { lastTurn?: { turnId: string } } }>(
      "threads.get",
      { threadId: thread.id },
    );
    expect(still.lastTurn?.turnId).toBe(first);
  });

  it("keeps the files of a thread in the project's checkout, and refuses to restore them", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<Thread>("threads.create", { projectId });
    const first = await turn(sc, thread.id, "/write a.txt one");
    await sc.until(checkpointOf(thread.id, 1, "ready"));
    await expect(
      sc.client.call("threads.rollback", {
        threadId: thread.id,
        beforeTurnId: first,
        restoreFiles: true,
      }),
    ).rejects.toThrow(
      "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.",
    );
    // Refused: nothing was dropped.
    expect(await turnIds(sc, thread.id)).toHaveLength(1);

    await sc.client.call("threads.rollback", { threadId: thread.id, beforeTurnId: first });
    expect(Fs.existsSync(Path.join(dir, "a.txt"))).toBe(true);
    await sc.until(checkpointOf(thread.id, 1, "stale"));
  });
});

describe("worktree list", () => {
  it("parses git's porcelain output", () => {
    expect(
      parseWorktreeList(
        "worktree /src/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/app/x\nHEAD def\ndetached\n\n",
      ),
    ).toEqual([
      { path: "/src/app", head: "abc", branch: "main", main: true },
      { path: "/w/app/x", head: "def", branch: null, main: false },
    ]);
  });
});
