import { execFileSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  worktreeSetupStream,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStageId,
} from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import { runSetupScript, wrapCommandForCompletion } from "../src/setup.ts";
import { node, repository, type Node } from "./support.ts";

/** Resolves with the first snapshot of the thread's setup (kept or new) that `match` accepts. */
function setupUntil(
  sc: Node,
  threadId: string,
  match: (snapshot: WorktreeSetupSnapshot) => boolean,
): Promise<WorktreeSetupSnapshot> {
  return new Promise((resolve) => {
    const subscription = sc.client.subscribe(worktreeSetupStream(threadId), {}, (event) => {
      const snapshot = event.payload as WorktreeSetupSnapshot;
      if (!match(snapshot)) return;
      subscription.dispose();
      resolve(snapshot);
    });
  });
}

const stage = (snapshot: WorktreeSetupSnapshot, id: WorktreeSetupStageId) =>
  snapshot.stages.find((entry) => entry.id === id);

/** Sends a message and resolves with how the turn ended. */
async function turn(sc: Node, threadId: string, text: string) {
  let done!: (status: string) => void;
  const ended = new Promise<string>((resolve) => (done = resolve));
  let wanted: string | undefined;
  const seen = new Map<string, string>();
  const subscription = sc.client.subscribe("threads", {}, (event) => {
    const record = event.payload as { id?: string; lastTurn?: { turnId: string; status: string } };
    if (event.type !== "threads.thread.updated" || record.id !== threadId || !record.lastTurn)
      return;
    if (record.lastTurn.status === "running") return;
    seen.set(record.lastTurn.turnId, record.lastTurn.status);
    if (record.lastTurn.turnId === wanted) done(record.lastTurn.status);
  });
  const { turnId } = await sc.client.call<{ turnId: string }>("threads.send", { threadId, text });
  wanted = turnId;
  const already = seen.get(turnId);
  if (already !== undefined) done(already);
  const status = await ended;
  subscription.dispose();
  return status;
}

async function projectWithScript(sc: Node, script: Record<string, unknown> | undefined) {
  const projectId = await sc.project(repository());
  if (script !== undefined) {
    await sc.client.call("projects.scripts.set", {
      projectId,
      scripts: [{ id: "setup", name: "Install", runOnWorktreeCreate: true, ...script }],
    });
  }
  return projectId;
}

describe("setup script wrapper", () => {
  it("sets the script's variables inside its block and prints the sentinel with its code", () => {
    const line = wrapCommandForCompletion('echo "$NAME"\nexit 4', "posix", "DONE:", {
      NAME: "it's here",
    });
    const out = execFileSync("sh", ["-c", `${line.replaceAll("\r", "\n")}; echo "[$NAME]"`], {
      encoding: "utf8",
    });
    expect(out.split("\n").filter(Boolean)).toEqual(["it's here", "DONE:4", "[]"]);
  });
});

describe("reading a setup script's terminal", () => {
  it("drops the echoed wrapper and script lines, keeping output that only ends like them", async () => {
    let listener: (event: { type: string; payload: unknown }) => void = () => {};
    let typed = "";
    const lines: string[] = [];
    const started = await runSetupScript({
      terminals: {
        open: async () => ({}) as never,
        write: ({ data }) => {
          typed = data;
        },
        resize: () => undefined,
        close: async () => 0,
        list: () => [],
        get: () => undefined,
      },
      follow: (_thread, _terminal, next) => {
        listener = next;
        return { dispose: () => undefined };
      },
      threadId: "t",
      script: {
        id: "s",
        name: "Build",
        command: "echo hi\nmake",
        icon: "play",
        runOnWorktreeCreate: true,
      },
      projectRoot: "/p",
      worktreePath: "/w",
      shell: "posix",
      onLine: (line) => lines.push(line),
    });
    const [first, middle, last] = typed.replace(/\r$/, "").split("\r");
    const sentinel = /(__JHIN_SETUP_DONE___[0-9a-f]+:)/.exec(typed)![1]!;
    const output = (data: string) => listener({ type: "terminal.output", payload: { data } });
    output(`user@host$ ${first}\r\n> ${middle}\r\n> ${last}\r\n`);
    output("hi\r\nrunning make\r\n");
    output(`\r\n${sentinel}0\r\n`);
    expect(await started!.completion).toBe(0);
    expect(lines).toEqual(["hi", "running make"]);
  });
});

describe("jhin.source-control: worktree setup (D1121–D1124)", () => {
  it("runs the project's setup script in a new worktree and tracks its stages", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    const projectId = await projectWithScript(sc, {
      command: 'echo "installing"\necho "$JHIN_WORKTREE_PATH" > setup.txt',
    });
    const threadId = "setup-thread";
    const scriptDone = setupUntil(sc, threadId, (s) => stage(s, "setup-script")?.status === "done");

    const thread = await sc.client.call<{ worktreePath: string }>("threads.create", {
      projectId,
      threadId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    const snapshot = await scriptDone;
    expect(snapshot).toMatchObject({
      phase: "running",
      baseRef: "main",
      worktreePath: thread.worktreePath,
      setupScript: { name: "Install", terminalId: "setup-setup" },
    });
    expect(snapshot.stages.map((entry) => [entry.id, entry.status])).toEqual([
      ["fetch", "skipped"],
      ["checkout", "done"],
      ["setup-script", "done"],
      ["agent", "pending"],
    ]);
    expect(stage(snapshot, "setup-script")).toMatchObject({
      detail: "exited with 0",
      tail: ["installing"],
    });
    expect(Fs.readFileSync(Path.join(thread.worktreePath, "setup.txt"), "utf8").trim()).toBe(
      thread.worktreePath,
    );
    // It ran in the worktree, with T3's variables, and its terminal went once it was done.
    expect(sc.terminals!.opened).toEqual([
      { threadId, terminalId: "setup-setup", cwd: thread.worktreePath },
    ]);
    expect(sc.terminals!.closed).toEqual(["setup-setup"]);

    // The first turn starts the agent and ends the setup.
    const finished = setupUntil(sc, threadId, (s) => s.phase === "done");
    expect(await turn(sc, threadId, "hello")).toBe("completed");
    expect(stage(await finished, "agent")?.status).toBe("done");
    expect(
      await sc.client.call<WorktreeSetupSnapshot>("git.worktree.setup.get", { threadId }),
    ).toMatchObject({ phase: "done" });
  });

  it("holds the agent for a script that is not async and fails the turn when it fails", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    const projectId = await projectWithScript(sc, {
      command: "echo broken >&2\nexit 3",
      async: false,
    });
    const threadId = "held-thread";
    await sc.client.call("threads.create", {
      projectId,
      threadId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    // The start hook fails the turn before its agent starts, so the send says why.
    await expect(sc.client.call("threads.send", { threadId, text: "hello" })).rejects.toThrow(
      "Setup script exited with 3.",
    );
    const snapshot = await sc.client.call<WorktreeSetupSnapshot>("git.worktree.setup.get", {
      threadId,
    });
    expect(snapshot.phase).toBe("failed");
    expect(snapshot.error).toBe("Setup script exited with 3.");
    expect(stage(snapshot, "setup-script")).toMatchObject({
      status: "failed",
      detail: "exited with 3",
      tail: ["broken"],
    });
    // A failed script keeps its terminal, for "Open terminal".
    expect(sc.terminals!.closed).toEqual([]);
  });

  it("cancels a running setup, and the held agent starts without it", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    // `cat` reads its input, which never ends: the script runs until it is stopped.
    const projectId = await projectWithScript(sc, { command: "cat", async: false });
    const threadId = "cancelled-thread";
    const running = setupUntil(sc, threadId, (s) => s.setupScript !== null);
    await sc.client.call("threads.create", {
      projectId,
      threadId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    await running;
    await sc.terminals!.typed("setup-setup");
    const ended = turn(sc, threadId, "hello");
    await setupUntil(sc, threadId, (s) => stage(s, "agent")?.status === "running");

    expect(
      await sc.client.call<{ cancelled: boolean }>("git.worktree.setup.cancel", { threadId }),
    ).toEqual({ cancelled: true });
    expect(await ended).toBe("completed");
    const snapshot = await sc.client.call<WorktreeSetupSnapshot>("git.worktree.setup.get", {
      threadId,
    });
    expect(snapshot.phase).toBe("cancelled");
    expect(stage(snapshot, "setup-script")?.status).toBe("skipped");
    expect(sc.terminals!.closed).toEqual(["setup-setup"]);
    // Nothing runs any more: a second cancel finds none.
    expect(
      await sc.client.call<{ cancelled: boolean }>("git.worktree.setup.cancel", { threadId }),
    ).toEqual({ cancelled: false });
    // A deleted thread's setup goes with it.
    await sc.client.call("threads.delete", { threadId });
    await sc.until(
      (event) =>
        event.type === "source-control.thread.removed" &&
        (event.payload as { threadId: string }).threadId === threadId,
    );
    expect(await sc.client.call("git.worktree.setup.get", { threadId })).toBeNull();
  });

  it("skips the script stage without a setup script, or without terminals", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    const bare = await projectWithScript(sc, undefined);
    await sc.client.call("threads.create", {
      projectId: bare,
      threadId: "bare",
      workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
    });
    const skipped = await setupUntil(
      sc,
      "bare",
      (s) => stage(s, "setup-script")?.status === "skipped",
    );
    // No origin to fetch from: the local branch is used, with a warning.
    expect(stage(skipped, "fetch")).toMatchObject({
      status: "warning",
      detail: "origin has no main",
    });
    expect(skipped.setupScript).toBeNull();

    const without = await node({ watch: false });
    const scripted = await projectWithScript(without, { command: "true" });
    await without.client.call("threads.create", {
      projectId: scripted,
      threadId: "no-terminals",
      workspace: { type: "worktree", baseRef: "main" },
    });
    const none = await setupUntil(
      without,
      "no-terminals",
      (s) => stage(s, "setup-script")?.status === "skipped",
    );
    expect(stage(none, "setup-script")?.detail).toBe("no terminals");
    // A thread in the project's checkout has no setup.
    await without.client.call("threads.create", { projectId: scripted, threadId: "local" });
    expect(await without.client.call("git.worktree.setup.get", { threadId: "local" })).toBeNull();
  });

  it("keeps a project's scripts and refuses two with one id", async () => {
    const sc = await node({ watch: false });
    const projectId = await projectWithScript(sc, { command: "pnpm install" });
    const [, project] = await sc.client.call<{ id: string; scripts?: unknown[] }[]>(
      "projects.list",
      {},
    );
    expect(project).toMatchObject({
      id: projectId,
      scripts: [
        {
          id: "setup",
          name: "Install",
          command: "pnpm install",
          icon: "play",
          runOnWorktreeCreate: true,
        },
      ],
    });
    await expect(
      sc.client.call("projects.scripts.set", {
        projectId,
        scripts: [
          { id: "a", name: "A", command: "a" },
          { id: "a", name: "B", command: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "PROJECT_SCRIPTS_INVALID" });
  });
});
