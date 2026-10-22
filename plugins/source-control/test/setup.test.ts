import { execFileSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  worktreeSetupStream,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStageId,
} from "@jhin/source-control-api";
import { describe, expect, it, vi } from "vite-plus/test";

import { completionShellOf, runSetupScript, wrapCommandForCompletion } from "../src/setup.ts";
import { redactUrls } from "../src/worktrees.ts";
import { git, node, repository, type Node } from "./support.ts";

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

describe("submodule warnings", () => {
  it("never show a URL's credentials", () => {
    expect(
      redactUrls("fatal: clone of 'https://bot:ghp_secret@github.com/acme/lib.git' failed"),
    ).toBe("fatal: clone of 'https://***@github.com/acme/lib.git' failed");
    expect(redactUrls("fatal: 'https://user:p@ss@host/x.git' failed")).toBe(
      "fatal: 'https://***@host/x.git' failed",
    );
    expect(redactUrls("fatal: 'https://host/x.git?access_token=abc&x=1' failed")).toBe(
      "fatal: 'https://host/x.git?access_token=***&x=1' failed",
    );
    expect(redactUrls("fatal: repository '/tmp/lib' not found")).toBe(
      "fatal: repository '/tmp/lib' not found",
    );
  });
});

describe("setup script wrapper", () => {
  it("wraps for the shell the terminal starts", () => {
    expect(completionShellOf("linux", "/usr/bin/fish")).toBe("fish");
    expect(completionShellOf("linux", "/bin/zsh")).toBe("posix");
    expect(completionShellOf("darwin", "/usr/local/bin/pwsh")).toBe("powershell");
    expect(completionShellOf("win32", "/bin/bash")).toBe("powershell");
  });

  it("wraps for fish and PowerShell with their own exit status and quoting", () => {
    const fish = wrapCommandForCompletion("make", "fish", "DONE:", { NAME: "it's" });
    expect(fish).toBe("begin\rset -lx NAME 'it\\'s'; make\rend; printf '\\nDONE:%s\\n' $status");
    const pwsh = wrapCommandForCompletion("make", "powershell", "DONE:", { NAME: "it's" });
    expect(pwsh).toContain("$env:NAME = 'it''s'; make");
    expect(pwsh).toContain('Write-Host "DONE:$__jc"');
    expect(pwsh).toContain("$LASTEXITCODE");
  });

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

  it("ends without an exit code when the terminal closes, even before follow returns", async () => {
    const started = await runSetupScript({
      terminals: {
        open: async () => ({}) as never,
        write: () => undefined,
        resize: () => undefined,
        close: async () => 0,
        list: () => [],
        get: () => undefined,
      },
      // The session is gone already: its stream ends at once.
      follow: (_thread, _terminal, next) => {
        next({ type: "terminal.closed", payload: {} });
        return { dispose: () => undefined };
      },
      threadId: "t",
      script: { id: "s", name: "S", command: "true", icon: "play", runOnWorktreeCreate: true },
      projectRoot: "/p",
      worktreePath: "/w",
      shell: "posix",
      onLine: () => undefined,
    });
    expect(await started!.completion).toBeNull();
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
    // A failed script keeps its terminal, for "Open terminal"…
    expect(sc.terminals!.closed).toEqual([]);
    // …until its thread goes.
    await sc.client.call("threads.delete", { threadId });
    await sc.until(
      (event) =>
        event.type === "source-control.thread.removed" &&
        (event.payload as { threadId: string }).threadId === threadId,
    );
    expect(sc.terminals!.closed).toEqual(["setup-setup"]);
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

  it("types nothing when cancelled while the terminal opens", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    const projectId = await projectWithScript(sc, { command: "echo never" });
    const hold = sc.terminals!.holdOpens();
    await sc.client.call("threads.create", {
      projectId,
      threadId: "opening",
      workspace: { type: "worktree", baseRef: "main" },
    });
    await hold.waiting;
    expect(
      await sc.client.call<{ cancelled: boolean }>("git.worktree.setup.cancel", {
        threadId: "opening",
      }),
    ).toEqual({ cancelled: true });
    const closing = sc.logged("closed a cancelled setup's terminal");
    hold.release();
    await closing;
    expect(sc.terminals!.typedInto).toEqual([]);
    expect(sc.terminals!.closed).toEqual(["setup-setup"]);
  });

  it("fails the first turn when a script that holds the agent cannot start", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    const projectId = await projectWithScript(sc, { command: "true", async: false });
    sc.terminals!.failOpens(new Error("no shell"));
    const failed = setupUntil(
      sc,
      "unstarted",
      (s) => stage(s, "setup-script")?.status === "failed",
    );
    await sc.client.call("threads.create", {
      projectId,
      threadId: "unstarted",
      workspace: { type: "worktree", baseRef: "main" },
    });
    expect((await failed).stages.find((entry) => entry.id === "setup-script")?.detail).toBe(
      "no shell",
    );
    await expect(
      sc.client.call("threads.send", { threadId: "unstarted", text: "hello" }),
    ).rejects.toThrow("Setup script exited with no exit code.");
  });

  it("shows a setup only to a caller that may read terminals", async () => {
    const sc = await node({ watch: false });
    await expect(
      sc.as(["git.read"]).call("git.worktree.setup.get", { threadId: "any" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(
      await sc
        .as(["git.read", "terminals.read"])
        .call("git.worktree.setup.get", { threadId: "any" }),
    ).toBeNull();
  });

  it("sets up only a thread that is still to be made", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    const projectId = await projectWithScript(sc, { command: "true" });
    const existing = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await expect(
      sc.client.call("git.worktree.create", { projectId, baseRef: "main", threadId: existing.id }),
    ).rejects.toMatchObject({ code: "WORKTREE_INVALID" });
    expect(sc.terminals!.opened).toEqual([]);
  });

  it("lets only a caller that may run a shell save a script (D1121)", async () => {
    const sc = await node({ watch: false });
    const projectId = await sc.project(repository());
    const scripts = [{ id: "s", name: "S", command: "true", runOnWorktreeCreate: true }];
    await expect(
      sc.as(["projects.write"]).call("projects.scripts.set", { projectId, scripts }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      sc
        .as(["projects.write", "terminals.write"])
        .call("projects.scripts.set", { projectId, scripts }),
    ).resolves.toMatchObject({ scripts: [{ id: "s" }] });
  });

  it("lets an async script that ended before the first turn go, ending the setup with the turn", async () => {
    const sc = await node({ watch: false }, { terminals: true });
    const projectId = await projectWithScript(sc, { command: "echo ready" });
    const threadId = "early";
    const exited = setupUntil(sc, threadId, (s) => stage(s, "setup-script")?.status === "done");
    await sc.client.call("threads.create", {
      projectId,
      threadId,
      workspace: { type: "worktree", baseRef: "main" },
    });
    await exited;
    const finished = setupUntil(sc, threadId, (s) => s.phase === "done");
    expect(await turn(sc, threadId, "hello")).toBe("completed");
    await finished;
    // Nothing is left to cancel.
    expect(
      await sc.client.call<{ cancelled: boolean }>("git.worktree.setup.cancel", { threadId }),
    ).toEqual({ cancelled: false });
  });

  it("checks a new worktree's submodules out, or leaves them empty with a warning (D1134)", async () => {
    // Local submodules need the file transport, which git turns off for them by default.
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "protocol.file.allow");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "always");
    try {
      const library = repository();
      const dir = repository();
      git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", library, "lib");
      git(dir, "commit", "--quiet", "-m", "lib");
      const sc = await node({ watch: false });
      const projectId = await sc.project(dir);
      const thread = await sc.client.call<{ worktreePath: string }>("threads.create", {
        projectId,
        threadId: "with-lib",
        workspace: { type: "worktree", baseRef: "main" },
      });
      expect(Fs.readFileSync(Path.join(thread.worktreePath, "lib", "README.md"), "utf8")).toBe(
        "one\ntwo\nthree\n",
      );
      const snapshot = await sc.client.call<WorktreeSetupSnapshot>("git.worktree.setup.get", {
        threadId: "with-lib",
      });
      expect(stage(snapshot, "checkout")?.status).toBe("done");
      // Gone from disk, it is made again from its branch at the next turn (D256), submodules too.
      Fs.rmSync(thread.worktreePath, { recursive: true, force: true });
      expect(await turn(sc, "with-lib", "hello")).toBe("completed");
      expect(Fs.readFileSync(Path.join(thread.worktreePath, "lib", "README.md"), "utf8")).toBe(
        "one\ntwo\nthree\n",
      );
      // A worktree with checked-out submodules goes only when forced: their commits
      // may be pushed nowhere, as git itself holds.
      await sc.client.call("threads.delete", { threadId: "with-lib" });
      await expect(
        sc.client.call("git.worktree.remove", { projectId, path: thread.worktreePath }),
      ).rejects.toThrow();
      expect(Fs.existsSync(thread.worktreePath)).toBe(true);
      await sc.client.call("git.worktree.remove", {
        projectId,
        path: thread.worktreePath,
        force: true,
      });
      expect(Fs.existsSync(thread.worktreePath)).toBe(false);

      sc.configure({ worktreeSubmodules: "none" });
      const empty = await sc.client.call<{ worktreePath: string }>("threads.create", {
        projectId,
        threadId: "without-lib",
        workspace: { type: "worktree", baseRef: "main" },
      });
      expect(Fs.readdirSync(Path.join(empty.worktreePath, "lib"))).toEqual([]);
      expect(
        stage(
          await sc.client.call<WorktreeSetupSnapshot>("git.worktree.setup.get", {
            threadId: "without-lib",
          }),
          "checkout",
        ),
      ).toMatchObject({ status: "done", detail: "submodules left empty" });

      // Top level only: a submodule's own submodule stays empty.
      const inner = repository();
      git(
        library,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--quiet",
        inner,
        "inner",
      );
      git(library, "commit", "--quiet", "-m", "inner");
      git(dir, "-C", "lib", "pull", "--quiet");
      git(dir, "commit", "--quiet", "-am", "lib with inner");
      sc.configure({ worktreeSubmodules: "top-level" });
      const top = await sc.client.call<{ worktreePath: string }>("threads.create", {
        projectId,
        threadId: "top-level",
        workspace: { type: "worktree", baseRef: "main" },
      });
      expect(Fs.existsSync(Path.join(top.worktreePath, "lib", "README.md"))).toBe(true);
      expect(Fs.readdirSync(Path.join(top.worktreePath, "lib", "inner"))).toEqual([]);

      // A submodule that cannot be fetched: the worktree is still used, with git's reason.
      Fs.rmSync(library, { recursive: true, force: true });
      sc.configure({ worktreeSubmodules: "recursive" });
      const broken = await sc.client.call<{ worktreePath: string }>("threads.create", {
        projectId,
        threadId: "broken-lib",
        workspace: { type: "worktree", baseRef: "main" },
      });
      expect(Fs.existsSync(broken.worktreePath)).toBe(true);
      const checkout = stage(
        await sc.client.call<WorktreeSetupSnapshot>("git.worktree.setup.get", {
          threadId: "broken-lib",
        }),
        "checkout",
      );
      expect(checkout?.status).toBe("warning");
      // git's own reason, its fatal or error line without the prefix, not a progress line.
      expect(checkout?.detail).toMatch(
        /^submodules not checked out: (?!Cloning).*(does not exist|not found|failed|unable)/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
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
