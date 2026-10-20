import * as Fs from "node:fs";

import type { GitActionProgress, GitActionResult, PullResult } from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import type { AgentItem, AgentRuntime } from "@jhin/agent-api";

import {
  agentWriter,
  parseCommitMessage,
  parseJsonObject,
  plainWriter,
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
  sanitizeSubject,
  splitUpstream,
} from "../src/index.ts";
import { fakeGh, git, node, repository, temp, write } from "./support.ts";

/** A repository whose `origin` is a bare repository on disk, pushed to once. */
function withRemote(url?: string) {
  const dir = repository();
  const remote = temp("jhin-sc-remote-");
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(dir, "remote", "add", "origin", url ?? remote);
  // A GitHub URL fetches nowhere: pushes go to the bare repository instead.
  if (url !== undefined) git(dir, "config", "remote.origin.pushurl", remote);
  git(dir, "push", "--quiet", "-u", remote, "main:main");
  git(dir, "fetch", "--quiet", remote, "+refs/heads/*:refs/remotes/origin/*");
  git(dir, "branch", "--quiet", "--set-upstream-to=origin/main", "main");
  return { dir, remote };
}

const log = (dir: string, ref = "HEAD") =>
  git(dir, "log", "--format=%s%n%b", "-n", "1", ref).trim();

describe("jhin.source-control: git actions", () => {
  it("commits every change with the given message and offers to push", async () => {
    const { dir } = withRemote();
    write(dir, "src/a.ts", "export const a = 1;\n");
    write(dir, "README.md", "one\ntwo\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit",
      commitMessage: "Add a\n\n- and trim the readme",
    });
    expect(result.commit).toMatchObject({ status: "created", subject: "Add a" });
    expect(result.push.status).toBe("skipped_not_requested");
    expect(result.toast).toEqual({
      title: `Committed ${result.commit.sha!.slice(0, 7)}`,
      description: "Add a",
      cta: { kind: "run_action", label: "Push", action: "push" },
    });
    expect(log(dir)).toBe("Add a\n- and trim the readme");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("commits only the files asked for", async () => {
    const { dir } = withRemote();
    write(dir, "a.txt", "a\n");
    write(dir, "b.txt", "b\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    await sc.client.call("git.action.run", {
      projectId,
      action: "commit",
      commitMessage: "Add a",
      filePaths: ["a.txt"],
    });
    expect(git(dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
    expect(git(dir, "status", "--porcelain").trim()).toBe("?? b.txt");
  });

  it("leaves what else the user staged staged when committing only some files", async () => {
    const { dir } = withRemote();
    write(dir, "a.txt", "a\n");
    write(dir, "staged.txt", "s\n");
    git(dir, "add", "staged.txt");
    const sc = await node();
    const projectId = await sc.project(dir);
    await sc.client.call("git.action.run", {
      projectId,
      action: "commit",
      commitMessage: "Add a",
      filePaths: ["a.txt"],
    });
    expect(git(dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
    expect(git(dir, "status", "--porcelain").trim()).toBe("A  staged.txt");
  });

  it("ends the progress of an action that fails before its steps", async () => {
    const { dir } = withRemote();
    git(dir, "switch", "--quiet", "--detach");
    const sc = await node();
    const projectId = await sc.project(dir);
    const progress: GitActionProgress[] = [];
    let failed!: () => void;
    const done = new Promise<void>((resolve) => (failed = resolve));
    sc.client.subscribe("source-control/actions", {}, (event: StoredEvent) => {
      const payload = event.payload as GitActionProgress;
      if (payload.actionId !== "act-d") return;
      progress.push(payload);
      if (payload.kind === "action_failed") failed();
    });
    await expect(
      sc.client.call("git.action.run", { projectId, action: "push", actionId: "act-d" }),
    ).rejects.toMatchObject({ message: "Cannot push from detached HEAD." });
    await done;
    expect(progress.map((event) => event.kind)).toEqual(["action_started", "action_failed"]);
  });

  it("writes the message itself when none is given", async () => {
    const { dir } = withRemote();
    write(dir, "src/feature.ts", "x\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit",
    });
    // The fake agent answers no JSON: the plain writer names the file.
    expect(result.commit.subject).toBe("Update feature.ts");
    expect(log(dir)).toBe("Update feature.ts");
  });

  it("commits, pushes with an upstream and streams its progress", async () => {
    const { dir, remote } = withRemote();
    git(dir, "switch", "--quiet", "--create", "feature");
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const progress: GitActionProgress[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    sc.client.subscribe("source-control/actions", {}, (event: StoredEvent) => {
      const payload = event.payload as GitActionProgress;
      if (payload.actionId !== "act-1") return;
      progress.push(payload);
      if (payload.kind === "action_finished") finished();
    });
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit_push",
      actionId: "act-1",
      commitMessage: "Add a",
    });
    await done;
    expect(result.actionId).toBe("act-1");
    expect(result.push).toEqual({
      status: "pushed",
      branch: "feature",
      upstream: "origin/feature",
      setUpstream: true,
    });
    expect(result.toast.title).toBe(`Pushed ${result.commit.sha!.slice(0, 7)} to origin/feature`);
    // Not GitHub: there is no pull request to offer.
    expect(result.toast.cta).toEqual({ kind: "none" });
    expect(git(remote, "rev-parse", "feature").trim()).toBe(result.commit.sha);
    expect(git(dir, "rev-parse", "--abbrev-ref", "feature@{upstream}").trim()).toBe(
      "origin/feature",
    );
    expect(
      progress.map((event) => (event.kind === "phase_started" ? event.label : event.kind)),
    ).toEqual(["action_started", "Committing...", "Pushing...", "action_finished"]);
    expect(progress[0]).toMatchObject({ kind: "action_started", phases: ["commit", "push"] });
  });

  it("streams what a commit hook prints, and reports a refusing hook", async () => {
    const { dir } = withRemote();
    write(dir, ".git/hooks/pre-commit", "#!/bin/sh\necho checking things\necho nope >&2\nexit 1\n");
    Fs.chmodSync(`${dir}/.git/hooks/pre-commit`, 0o755);
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const progress: GitActionProgress[] = [];
    let failed!: () => void;
    const done = new Promise<void>((resolve) => (failed = resolve));
    sc.client.subscribe("source-control/actions", {}, (event: StoredEvent) => {
      const payload = event.payload as GitActionProgress;
      progress.push(payload);
      if (payload.kind === "action_failed") failed();
    });
    await expect(
      sc.client.call("git.action.run", { projectId, action: "commit", commitMessage: "Add a" }),
    ).rejects.toMatchObject({ code: "GIT_FAILED" });
    await done;
    expect(progress).toContainEqual(
      // git hands a hook's stdout to stderr.
      expect.objectContaining({ kind: "hook_output", text: "checking things" }),
    );
    expect(progress).toContainEqual(
      expect.objectContaining({ kind: "hook_output", stream: "stderr", text: "nope" }),
    );
    expect(progress.at(-1)).toMatchObject({ kind: "action_failed", phase: "commit" });
  });

  it("commits on a new feature branch named after the changes, and moves the thread to it", async () => {
    const { dir } = withRemote();
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", {
      projectId,
    });
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      threadId: thread.id,
      action: "commit",
      commitMessage: "Add the A file",
      featureBranch: true,
    });
    expect(result.branch).toEqual({ status: "created", name: "feature/add-the-a-file" });
    expect(git(dir, "branch", "--show-current").trim()).toBe("feature/add-the-a-file");
    const status = await sc.client.call<{ thread: { branch: string } }>("git.thread.status", {
      threadId: thread.id,
    });
    expect(status.thread.branch).toBe("feature/add-the-a-file");
  });

  it("refuses what cannot run: a feature branch without changes, a push from a detached HEAD", async () => {
    const { dir } = withRemote();
    const sc = await node();
    const projectId = await sc.project(dir);
    await expect(
      sc.client.call("git.action.run", { projectId, action: "commit", featureBranch: true }),
    ).rejects.toMatchObject({
      code: "ACTION_UNAVAILABLE",
      message: "Cannot create a feature branch because there are no changes to commit.",
    });
    await expect(
      sc.client.call("git.action.run", { projectId, action: "push", featureBranch: true }),
    ).rejects.toMatchObject({
      message: "Feature-branch checkout is only supported for commit actions.",
    });
    git(dir, "switch", "--quiet", "--detach");
    await expect(
      sc.client.call("git.action.run", { projectId, action: "push" }),
    ).rejects.toMatchObject({
      code: "ACTION_UNAVAILABLE",
      message: "Cannot push from detached HEAD.",
    });
  });

  it("says there is nothing to push when the branch is up to date, and that no remote is set", async () => {
    const { dir } = withRemote();
    const sc = await node();
    const projectId = await sc.project(dir);
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "push",
    });
    expect(result.push.status).toBe("skipped_up_to_date");
    expect(result.toast).toEqual({ title: "Done", cta: { kind: "none" } });

    const lone = repository();
    git(lone, "switch", "--quiet", "--create", "feature");
    const other = await sc.project(lone);
    await expect(
      sc.client.call("git.action.run", { projectId: other, action: "push" }),
    ).rejects.toMatchObject({
      message: "Cannot push because no git remote is configured for this repository.",
    });
  });

  it("commits, pushes and creates a pull request on GitHub, then offers to view it", async () => {
    const gh = fakeGh();
    const { dir } = withRemote("https://github.com/acme/demo.git");
    git(dir, "switch", "--quiet", "--create", "feature");
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit_push_pr",
      commitMessage: "Add a",
    });
    expect(result.pr).toMatchObject({
      status: "created",
      pullRequest: { number: 42, title: "Add a", headBranch: "feature", baseBranch: "main" },
    });
    expect(result.toast).toEqual({
      title: "Created PR #42",
      description: "Add a",
      cta: { kind: "open_pr", label: "View PR", url: "https://github.com/acme/demo/pull/42" },
    });
    expect(gh.calls()).toContainEqual(
      expect.stringMatching(/^pr create --base main --head feature --title Add a --body-file /),
    );
    expect(gh.body("feature")).toBe("## Summary\n- Add a\n\n## Testing\n- Not run");

    // The same action again opens the existing one.
    write(dir, "b.txt", "b\n");
    const again = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit_push_pr",
      commitMessage: "Add b",
    });
    expect(again.pr.status).toBe("opened_existing");
    expect(again.toast.title).toBe("Opened PR #42");
  });

  it("targets the branch a branch was cut from, and follows the repository's template", async () => {
    const gh = fakeGh();
    const { dir } = withRemote("https://github.com/acme/demo.git");
    write(dir, ".github/pull_request_template.md", "## What\n<!-- describe -->\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "template");
    git(dir, "push", "--quiet", "origin", "main");
    git(
      dir,
      "fetch",
      "--quiet",
      git(dir, "config", "remote.origin.pushurl").trim(),
      "+refs/heads/*:refs/remotes/origin/*",
    );
    git(dir, "switch", "--quiet", "--create", "dev");
    git(dir, "push", "--quiet", "-u", "origin", "dev");
    git(
      dir,
      "fetch",
      "--quiet",
      git(dir, "config", "remote.origin.pushurl").trim(),
      "+refs/heads/*:refs/remotes/origin/*",
    );
    git(dir, "switch", "--quiet", "--create", "topic", "--track", "origin/dev");
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit_push_pr",
      commitMessage: "Add a",
    });
    // Pushed to its own branch, never onto `dev`, and the pull request goes into `dev`.
    expect(result.push).toMatchObject({ status: "pushed", upstream: "origin/topic" });
    expect(git(dir, "config", "branch.topic.gh-merge-base").trim()).toBe("dev");
    expect(result.pr.pullRequest?.baseBranch).toBe("dev");
    expect(gh.calls()).toContainEqual(expect.stringContaining("pr create --base dev --head topic"));
  });

  it("refuses a pull request from the default branch before committing anything", async () => {
    fakeGh();
    const { dir } = withRemote("https://github.com/acme/demo.git");
    git(dir, "remote", "set-head", "origin", "main");
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    await expect(
      sc.client.call("git.action.run", { projectId, action: "commit_push_pr", commitMessage: "A" }),
    ).rejects.toMatchObject({
      code: "ACTION_UNAVAILABLE",
      message:
        "Cannot create a pull request from the default branch main: check out a feature branch first.",
    });
    expect(git(dir, "status", "--porcelain").trim()).toBe("?? a.txt");
  });

  it("publishes a branch that follows another before opening its pull request", async () => {
    const gh = fakeGh();
    const { dir, remote } = withRemote("https://github.com/acme/demo.git");
    git(dir, "switch", "--quiet", "--create", "topic", "--track", "origin/main");
    write(dir, "a.txt", "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "Add a");
    git(dir, "push", "--quiet", remote, "HEAD:main");
    git(dir, "fetch", "--quiet", remote, "+refs/heads/*:refs/remotes/origin/*");
    const sc = await node();
    const projectId = await sc.project(dir);
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "create_pr",
    });
    expect(result.push).toMatchObject({ status: "pushed", upstream: "origin/topic" });
    expect(git(remote, "rev-parse", "topic").trim()).toBe(git(dir, "rev-parse", "HEAD").trim());
    expect(gh.calls()).toContainEqual(
      expect.stringContaining("pr create --base main --head topic"),
    );
  });

  it("reports GitHub's refusal to create a pull request", async () => {
    const gh = fakeGh();
    gh.failCreate(1, "pull request create failed: GraphQL: No commits between main and feature\n");
    const { dir } = withRemote("https://github.com/acme/demo.git");
    git(dir, "switch", "--quiet", "--create", "feature");
    write(dir, "a.txt", "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "Add a");
    const sc = await node();
    const projectId = await sc.project(dir);
    await expect(
      sc.client.call("git.action.run", { projectId, action: "create_pr" }),
    ).rejects.toMatchObject({
      code: "PULL_REQUEST_FAILED",
      message: "pull request create failed: GraphQL: No commits between main and feature",
    });
  });

  it("pulls fast-forward only, and says when there is nothing to pull", async () => {
    const { dir, remote } = withRemote();
    const other = temp("jhin-sc-clone-");
    git(other, "clone", "--quiet", remote, ".");
    write(other, "x.txt", "x\n");
    git(other, "add", ".");
    git(
      other,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "-m",
      "x",
    );
    git(other, "push", "--quiet", "origin", "main");
    const sc = await node();
    const projectId = await sc.project(dir);
    expect(await sc.client.call<PullResult>("git.pull", { projectId })).toEqual({
      status: "pulled",
      branch: "main",
      upstream: "origin/main",
    });
    expect(log(dir)).toBe("x");
    expect(await sc.client.call<PullResult>("git.pull", { projectId })).toMatchObject({
      status: "skipped_up_to_date",
    });
  });

  it("reports how far a branch is ahead of the default branch, and whether it has a remote", async () => {
    const { dir } = withRemote();
    git(dir, "switch", "--quiet", "--create", "feature");
    write(dir, "a.txt", "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "a");
    const sc = await node();
    const projectId = await sc.project(dir);
    const status = (await sc.status(projectId, true)).projects[0]!;
    expect(status).toMatchObject({ aheadOfDefault: 1, hasPrimaryRemote: true });
  });
});

describe("git action helpers", () => {
  it("names feature branches as T3 Code does", () => {
    expect(sanitizeFeatureBranchName('Add the "A" file.')).toBe("feature/add-the-a-file");
    expect(sanitizeFeatureBranchName("fix/Login bug")).toBe("fix/login-bug");
    expect(sanitizeFeatureBranchName("")).toBe("feature/update");
    expect(resolveAutoFeatureBranchName(["feature/x", "Feature/X-2"], "x")).toBe("feature/x-3");
    expect(resolveAutoFeatureBranchName(["feature/x/y"], "feature/x")).toBe("feature/x-2");
  });

  it("splits messages and upstreams", () => {
    expect(parseCommitMessage("  Subject\nbody one\nbody two ")).toEqual({
      subject: "Subject",
      body: "body one\nbody two",
    });
    expect(sanitizeSubject("Fix it.\nmore")).toBe("Fix it");
    expect(sanitizeSubject("   ")).toBe("Update project files");
    expect(splitUpstream("upstream/team/feature", ["origin", "upstream", "upstream/team"])).toEqual(
      {
        remote: "upstream/team",
        branch: "feature",
      },
    );
  });

  it("reads JSON from a model's answer, fenced or not", () => {
    expect(parseJsonObject('```json\n{"subject":"a","body":""}\n```')).toEqual({
      subject: "a",
      body: "",
    });
    expect(parseJsonObject('Sure: {"title":"t"} done')).toEqual({ title: "t" });
    expect(parseJsonObject("no json")).toBeUndefined();
  });

  it("writes plain messages without a model", async () => {
    expect(
      await plainWriter.commitMessage({
        branch: "main",
        summary: " a/b.ts | 2 +-\n c.ts | 1 +\n 2 files changed\n",
        patch: "",
        includeBranch: true,
      }),
    ).toEqual({ subject: "Update 2 files", body: "", branch: "Update 2 files" });
  });
});

describe("the agent writer", () => {
  /** A runtime whose turn never ends unless interrupted, and says whether it was. */
  function stalling() {
    let interrupted = false;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const runtime: AgentRuntime = {
      agentId: "stall",
      startTurn: () => ({
        // Yields nothing, and ends only once interrupted.
        items: {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<AgentItem>> => {
              await stopped;
              return { done: true, value: undefined };
            },
          }),
        },
        interrupt: () => {
          interrupted = true;
          stop();
        },
      }),
    };
    return { runtime, interrupted: () => interrupted };
  }

  it("falls back to a plain message when the agent's turn passes its deadline", async () => {
    const { runtime, interrupted } = stalling();
    // The deadline is started with the turn; it is reached once the turn has begun.
    let started!: (reach: () => void) => void;
    const begun = new Promise<() => void>((resolve) => (started = resolve));
    const warnings: string[] = [];
    const writer = agentWriter({
      runtime: async () => runtime,
      deadline: () => {
        let reach!: () => void;
        const reached = new Promise<void>((resolve) => (reach = resolve));
        started(reach);
        return { reached, dispose: () => undefined };
      },
      warn: (message) => warnings.push(message),
    });
    const written = writer.commitMessage({
      branch: "main",
      summary: " a.ts | 1 +\n",
      patch: "",
      includeBranch: false,
    });
    (await begun)();
    expect(await written).toEqual({ subject: "Update a.ts", body: "" });
    expect(interrupted()).toBe(true);
    expect(warnings).toEqual(["the writer failed"]);
  });

  it("titles a plain pull request after its one commit, body lines aside", async () => {
    expect(
      await plainWriter.pullRequest({
        base: "main",
        head: "feature",
        commits: "Add a\n- with a body line",
        subjects: ["Add a"],
        stat: "",
        patch: "",
      }),
    ).toEqual({ title: "Add a", body: "## Summary\n- Add a\n\n## Testing\n- Not run" });
  });
});
