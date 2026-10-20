import { execFileSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import type { Diff, TurnCheckpoint } from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { createGit } from "../src/git.ts";
import {
  captureCheckpoint,
  checkpointFiles,
  checkpointRef,
  restoreCheckpoint,
} from "../src/checkpoints.ts";
import { git, node, repository, temp, write, type Node } from "./support.ts";

const checkpointEvent =
  (threadId: string, count: number) =>
  (event: StoredEvent): boolean =>
    event.type === "source-control.checkpoint.changed" &&
    (event.payload as TurnCheckpoint).threadId === threadId &&
    (event.payload as TurnCheckpoint).turn === count;

/**
 * Sends a message and waits until the thread's record says the turn ended: the
 * thread takes the next message from then on.
 */
async function turn(sc: Node, threadId: string, text: string, ending = "completed") {
  const seen: { turnId: string; status: string }[] = [];
  let wanted: string | undefined;
  let done!: () => void;
  const ended = new Promise<void>((resolve) => (done = resolve));
  const subscription = sc.client.subscribe("threads", {}, (event) => {
    const record = event.payload as { id?: string; lastTurn?: { turnId: string; status: string } };
    if (event.type !== "threads.thread.updated" || record.id !== threadId || !record.lastTurn)
      return;
    seen.push(record.lastTurn);
    if (record.lastTurn.turnId === wanted && record.lastTurn.status === ending) done();
  });
  const { turnId } = await sc.client.call<{ turnId: string }>("threads.send", { threadId, text });
  wanted = turnId;
  if (seen.some((last) => last.turnId === turnId && last.status === ending)) done();
  await ended;
  subscription.dispose();
  return turnId;
}

const refs = (dir: string) =>
  git(dir, "for-each-ref", "--format=%(refname)", "refs/jhin/").trim().split("\n").filter(Boolean);

describe("jhin.source-control: checkpoints", () => {
  it("snapshots the working tree before the first turn and after each, without touching the index", async () => {
    const dir = repository();
    write(dir, "draft.txt", "mine\n");
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const { id: threadId } = await sc.client.call<{ id: string }>("threads.create", { projectId });

    const turnId = await turn(sc, threadId, "/write src/a.txt hello");
    const first = (await sc.until(checkpointEvent(threadId, 1))).payload as TurnCheckpoint;

    expect(first).toMatchObject({
      threadId,
      turnId,
      turn: 1,
      ref: `refs/jhin/checkpoints/${threadId}/1`,
      status: "ready",
      fileCount: 1,
      insertions: 1,
      deletions: 0,
      files: [{ path: "src/a.txt", status: "added", insertions: 1 }],
    });
    expect(refs(dir)).toEqual([
      `refs/jhin/checkpoints/${threadId}/0`,
      `refs/jhin/checkpoints/${threadId}/1`,
    ]);
    // The user's index, HEAD and branch are as they were: both files are still untracked.
    expect(git(dir, "status", "--porcelain")).toBe("?? draft.txt\n?? src/\n");
    expect(git(dir, "branch", "--list")).toBe("* main\n");
    // The snapshot holds the untracked files too.
    expect(git(dir, "show", `${first.ref}:draft.txt`)).toBe("mine\n");

    const snapshot = await sc.status();
    expect(snapshot.checkpoints).toEqual([first]);
    const { checkpoints } = await sc.client.call<{ checkpoints: TurnCheckpoint[] }>(
      "git.checkpoints",
      { threadId },
    );
    expect(checkpoints).toEqual([first]);
  });

  it("diffs a turn against the one before it, or from any earlier turn", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const { id: threadId } = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await turn(sc, threadId, "/write a.txt one");
    await turn(sc, threadId, "/write b.txt two");
    await turn(sc, threadId, "/write a.txt three");
    const third = (await sc.until(checkpointEvent(threadId, 3))).payload as TurnCheckpoint;
    expect(third.files.map((file) => [file.path, file.status])).toEqual([["a.txt", "modified"]]);

    const second = await sc.client.call<Diff>("git.diff", { threadId, scope: "turn", turn: 2 });
    expect(second).toMatchObject({ scope: "turn", fromTurn: 1, turn: 2, projectId });
    expect(second.files.map((file) => file.path)).toEqual(["b.txt"]);
    expect(second.patch).toContain("+++ b/b.txt");
    expect(second.patch).not.toContain("a.txt");

    const whole = await sc.client.call<Diff>("git.diff", {
      threadId,
      scope: "turn",
      turn: 3,
      fromTurn: 0,
    });
    expect(whole.files.map((file) => [file.path, file.status])).toEqual([
      ["a.txt", "added"],
      ["b.txt", "added"],
    ]);
    expect(whole.patch).toContain("+three");

    await expect(
      sc.client.call("git.diff", { threadId, scope: "turn", turn: 7 }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
    await expect(sc.client.call("git.diff", { threadId, scope: "turn" })).rejects.toThrow(
      "Invalid input for git.diff",
    );
  });

  it("records a stopped turn, skips a failed one, and starts the next from where it is", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const { id: threadId } = await sc.client.call<{ id: string }>("threads.create", { projectId });

    await turn(sc, threadId, "/fail now", "failed");
    // Changes between turns belong to no turn once a turn starts after them.
    write(dir, "between.txt", "x\n");
    await turn(sc, threadId, "/write c.txt three");
    const second = (await sc.until(checkpointEvent(threadId, 2))).payload as TurnCheckpoint;
    expect(second.files.map((file) => file.path)).toEqual(["c.txt"]);
    expect(refs(dir)).toEqual([
      `refs/jhin/checkpoints/${threadId}/0`,
      `refs/jhin/checkpoints/${threadId}/1`,
      `refs/jhin/checkpoints/${threadId}/2`,
    ]);
    expect(
      sc.events.some(
        (event) =>
          event.type === "source-control.checkpoint.changed" &&
          (event.payload as TurnCheckpoint).turn === 1,
      ),
    ).toBe(false);

    const stopped = new Promise<void>((resolve) => {
      const subscription = sc.client.subscribe(`thread/${threadId}`, {}, (event) => {
        if (event.type === "agent.item.delta") {
          subscription.dispose();
          resolve();
        }
      });
    });
    const interrupted = new Promise<void>((resolve) => {
      const subscription = sc.client.subscribe(`thread/${threadId}`, {}, (event) => {
        if (event.type === "agent.turn.interrupted") {
          subscription.dispose();
          resolve();
        }
      });
    });
    await sc.client.call("threads.send", { threadId, text: "/hold on" });
    await stopped;
    await sc.client.call("threads.interrupt", { threadId });
    await interrupted;
    expect((await sc.until(checkpointEvent(threadId, 3))).payload).toMatchObject({
      status: "ready",
      fileCount: 0,
    });
  });

  it("snapshots a project folder inside a larger repository, and records a turn without its start as an error", async () => {
    const dir = repository();
    const project = Path.join(dir, "app");
    Fs.mkdirSync(project);
    const sc = await node({ watch: false });
    const projectId = await sc.project(project);
    const { id: threadId } = await sc.client.call<{ id: string }>("threads.create", { projectId });
    const held = (type: string) =>
      new Promise<void>((resolve) => {
        const subscription = sc.client.subscribe(`thread/${threadId}`, {}, (event) => {
          if (event.type === type) {
            subscription.dispose();
            resolve();
          }
        });
      });

    // A file written outside the project's folder during the turn is not the project's.
    const holding = held("agent.item.delta");
    const interrupted = held("agent.turn.interrupted");
    await sc.client.call("threads.send", { threadId, text: "/hold on" });
    await holding;
    write(dir, "outside.txt", "elsewhere\n");
    write(project, "inside.txt", "here\n");
    await sc.client.call("threads.interrupt", { threadId });
    await interrupted;
    const first = (await sc.until(checkpointEvent(threadId, 1))).payload as TurnCheckpoint;
    expect(first.files.map((file) => file.path)).toEqual(["app/inside.txt"]);

    // Its start went missing: what the turn changed is unknown, not nothing.
    const again = held("agent.item.delta");
    const stopped = held("agent.turn.interrupted");
    await sc.client.call("threads.send", { threadId, text: "/hold on" });
    await again;
    git(dir, "update-ref", "-d", `refs/jhin/checkpoints/${threadId}/1`);
    await sc.client.call("threads.interrupt", { threadId });
    await stopped;
    expect((await sc.until(checkpointEvent(threadId, 2))).payload).toMatchObject({
      status: "error",
      fileCount: 0,
    });
  });

  it("snapshots a repository without commits, and one whose first commit came during the turn", async () => {
    const dir = temp("jhin-sc-unborn-");
    git(dir, "init", "--quiet", "--initial-branch=main");
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const { id: threadId } = await sc.client.call<{ id: string }>("threads.create", { projectId });

    await turn(sc, threadId, "/write first.txt one");
    expect((await sc.until(checkpointEvent(threadId, 1))).payload).toMatchObject({
      status: "ready",
      files: [{ path: "first.txt", status: "added" }],
    });
    // HEAD is born between the turns: the second turn's own file is still its own.
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "first");
    await turn(sc, threadId, "/write second.txt two");
    const second = (await sc.until(checkpointEvent(threadId, 2))).payload as TurnCheckpoint;
    expect(second.status).toBe("ready");
    expect(second.files.map((file) => file.path)).toEqual(["second.txt"]);
  });

  it("takes no checkpoints outside a repository or in the scratch project", async () => {
    const plain = temp("jhin-sc-plain-");
    const sc = await node({ watch: false });
    const projectId = await sc.project(plain);
    const { id: inPlain } = await sc.client.call<{ id: string }>("threads.create", { projectId });
    const { id: scratch } = await sc.client.call<{ id: string }>("threads.create", {});
    await turn(sc, inPlain, "/write a.txt one");
    await turn(sc, scratch, "/write a.txt one");

    expect((await sc.status()).checkpoints).toEqual([]);
    expect(sc.events.filter((event) => event.type === "source-control.checkpoint.changed")).toEqual(
      [],
    );
  });

  it("forgets a deleted thread's checkpoints and deletes their refs", async () => {
    const dir = repository();
    const sc = await node({ watch: false });
    const projectId = await sc.project(dir);
    const { id: threadId } = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await turn(sc, threadId, "/write a.txt one");
    await sc.until(checkpointEvent(threadId, 1));

    await sc.client.call("threads.delete", { threadId });
    await sc.until(
      (event) =>
        event.type === "source-control.thread.removed" &&
        (event.payload as { threadId: string }).threadId === threadId,
    );
    expect(refs(dir)).toEqual([]);
    expect((await sc.status()).checkpoints).toEqual([]);
  });
});

describe("checkpoint git operations", () => {
  const GIT = "git";

  it("leaves out what came with HEAD moving (a pull), keeping the turn's own files", async () => {
    const dir = repository();
    // Someone else's commit from long ago, pulled in during the turn.
    git(dir, "checkout", "--quiet", "-b", "upstream");
    write(dir, "pulled.txt", "theirs\n");
    git(dir, "add", "pulled.txt");
    execFileSync("git", ["commit", "--quiet", "-m", "pulled"], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Them",
        GIT_AUTHOR_EMAIL: "them@example.com",
        GIT_COMMITTER_NAME: "Them",
        GIT_COMMITTER_EMAIL: "them@example.com",
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });
    git(dir, "checkout", "--quiet", "main");

    const run = createGit(GIT, dir);
    const commonDir = Path.join(dir, ".git");
    await captureCheckpoint(run, commonDir, checkpointRef("t", 0));
    write(dir, "own.txt", "mine\n");
    git(dir, "merge", "--quiet", "--ff-only", "upstream");
    await captureCheckpoint(run, commonDir, checkpointRef("t", 1));

    const files = await checkpointFiles(run, checkpointRef("t", 0), checkpointRef("t", 1), {
      ignoreWhitespace: false,
    });
    expect(files.map((file) => file.path)).toEqual(["own.txt"]);
  });

  it("restores a checkpoint's files, leaving HEAD, the branch and ignored files", async () => {
    const dir = repository();
    write(dir, ".gitignore", "build/\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "--quiet", "-m", "ignore");
    write(dir, "kept.txt", "before\n");
    const run = createGit(GIT, dir);
    await captureCheckpoint(run, Path.join(dir, ".git"), checkpointRef("t", 0));

    write(dir, "kept.txt", "after\n");
    write(dir, "new.txt", "new\n");
    write(dir, "build/out.js", "built\n");
    Fs.writeFileSync(Path.join(dir, "README.md"), "changed\n");
    git(dir, "add", "README.md");

    expect(await restoreCheckpoint(run, dir, checkpointRef("t", 0))).toBe(true);
    expect(Fs.readFileSync(Path.join(dir, "kept.txt"), "utf8")).toBe("before\n");
    expect(Fs.existsSync(Path.join(dir, "new.txt"))).toBe(false);
    expect(Fs.readFileSync(Path.join(dir, "README.md"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(Fs.existsSync(Path.join(dir, "build/out.js"))).toBe(true);
    // The index is HEAD's again: the restored file is untracked, as it was.
    expect(git(dir, "status", "--porcelain")).toBe("?? kept.txt\n");
    expect(await restoreCheckpoint(run, dir, checkpointRef("t", 9))).toBe(false);
  });
});
