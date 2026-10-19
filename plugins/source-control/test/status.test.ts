import type { Branch, Diff, ProjectStatus } from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import { parseNumstat, parseStatus } from "../src/index.ts";
import { git, node, repository, statusEvent, temp, threadEvent, write } from "./support.ts";

const only = (snapshot: { projects: ProjectStatus[] }) => snapshot.projects[0]!;

describe("jhin.source-control: reading a repository", () => {
  it("reports the branch and a clean working tree", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const status = only(await sc.status(projectId));
    expect(status).toMatchObject({
      projectId,
      isRepo: true,
      root: dir,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      defaultBranch: "main",
      remoteUrl: null,
      provider: null,
      workingTree: { files: [], fileCount: 0, insertions: 0, deletions: 0, truncated: false },
    });
  });

  it("counts uncommitted changes against HEAD, untracked files as added lines", async () => {
    const dir = repository();
    write(dir, "README.md", "one\n2\nthree\nfour\n");
    write(dir, "src/new.ts", "export const a = 1;\nexport const b = 2;\n");
    write(dir, "image.bin", "\0\0binary");
    const sc = await node();
    const projectId = await sc.project(dir);
    const status = only(await sc.status(projectId));
    expect(status.workingTree).toEqual({
      files: [
        { path: "README.md", status: "modified", insertions: 2, deletions: 1, binary: false },
        { path: "image.bin", status: "untracked", insertions: 0, deletions: 0, binary: true },
        { path: "src/new.ts", status: "untracked", insertions: 2, deletions: 0, binary: false },
      ],
      fileCount: 3,
      insertions: 4,
      deletions: 1,
      truncated: false,
    });
  });

  it("says why a project is no repository", async () => {
    const plain = temp("jhin-sc-plain-");
    const sc = await node();
    const projectId = await sc.project(plain);
    expect(only(await sc.status(projectId))).toMatchObject({
      isRepo: false,
      reason: "Not a git repository",
      branch: null,
    });
  });

  it("never reads the scratch project as a repository, even inside one", async () => {
    // The node's home (and the scratch project's folder in it) inside a repository.
    const dir = repository();
    const sc = await node({}, { data: `${dir}/home` });
    const scratch = (await sc.status()).projects.find((project) => project.projectId === "scratch");
    expect(scratch).toMatchObject({
      isRepo: false,
      reason: "Chats without a project have no repository",
    });
  });

  it("reports commits ahead of and behind the upstream", async () => {
    const remote = temp("jhin-sc-remote-");
    git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    const dir = repository();
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "--quiet", "--set-upstream", "origin", "main");
    // Another clone pushes one commit; this one commits two of its own and fetches.
    const other = temp("jhin-sc-other-");
    git(other, "clone", "--quiet", remote, ".");
    write(other, "OTHER.md", "x\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "other");
    git(other, "push", "--quiet");
    for (const name of ["a", "b"]) {
      write(dir, `${name}.md`, `${name}\n`);
      git(dir, "add", ".");
      git(dir, "commit", "--quiet", "-m", name);
    }
    git(dir, "fetch", "--quiet");
    const sc = await node();
    const projectId = await sc.project(dir);
    expect(only(await sc.status(projectId))).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      remoteUrl: remote,
    });
  });

  it("follows the repository: a file written on disk is published on the stream", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    await sc.status(projectId);
    write(dir, "notes/todo.md", "a\nb\nc\n");
    const event = await sc.until(
      statusEvent(projectId, (status) => status.workingTree.insertions === 3),
    );
    expect((event.payload as ProjectStatus).workingTree.files).toEqual([
      { path: "notes/todo.md", status: "untracked", insertions: 3, deletions: 0, binary: false },
    ]);
    // A commit made outside the node shows too: the tree is clean again.
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "notes");
    const clean = statusEvent(projectId, (status) => status.workingTree.fileCount === 0);
    await sc.until((next) => next.sequence > event.sequence && clean(next));
  });

  it("publishes a status only when it changed", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    await sc.status(projectId);
    const published = sc.events.filter((event) => event.type === "source-control.status.changed");
    await sc.status(projectId, true);
    await sc.status(projectId, true);
    expect(sc.events.filter((event) => event.type === "source-control.status.changed")).toEqual(
      published,
    );
  });

  it("follows the project list: a project removed is reported", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    await sc.status(projectId);
    await sc.client.call("projects.delete", { projectId });
    await sc.until(
      (event) =>
        event.type === "source-control.project.removed" &&
        (event.payload as { projectId: string }).projectId === projectId,
    );
    await expect(sc.status(projectId)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});

describe("jhin.source-control: diffs", () => {
  it("diffs uncommitted changes, untracked files as additions", async () => {
    const dir = repository();
    write(dir, "README.md", "one\nTWO\nthree\n");
    write(dir, "new.txt", "hello\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const diff = await sc.client.call<Diff>("git.diff", { projectId });
    expect(diff).toMatchObject({
      scope: "uncommitted",
      baseRef: null,
      truncated: false,
      insertions: 2,
      deletions: 1,
    });
    expect(diff.files.map((file) => [file.path, file.status])).toEqual([
      ["README.md", "modified"],
      ["new.txt", "untracked"],
    ]);
    expect(diff.patch).toContain("diff --git a/README.md b/README.md");
    expect(diff.patch).toContain("-two\n+TWO\n");
    expect(diff.patch).toContain("+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n");
  });

  it("diffs a branch against where it left the default branch", async () => {
    const dir = repository();
    git(dir, "switch", "--quiet", "--create", "feature");
    write(dir, "feature.md", "f1\nf2\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "feature");
    // main moves on; its change is not part of the branch's diff.
    git(dir, "switch", "--quiet", "main");
    write(dir, "main.md", "m\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "main");
    git(dir, "switch", "--quiet", "feature");
    write(dir, "README.md", "one\ntwo\nthree\nfour\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const diff = await sc.client.call<Diff>("git.diff", { projectId, scope: "branch" });
    expect(diff).toMatchObject({
      baseRef: "main",
      headRef: "feature",
      insertions: 3,
      deletions: 0,
    });
    expect(diff.files.map((file) => file.path)).toEqual(["README.md", "feature.md"]);
    expect(diff.patch).not.toContain("main.md");
  });

  it("refuses a diff of a project that is no repository", async () => {
    const sc = await node();
    const projectId = await sc.project(temp("jhin-sc-plain-"));
    await expect(sc.client.call("git.diff", { projectId })).rejects.toMatchObject({
      code: "NOT_A_REPOSITORY",
    });
  });
});

describe("jhin.source-control: branches", () => {
  it("lists branches, checks one out and creates one", async () => {
    const dir = repository();
    git(dir, "branch", "older");
    const sc = await node();
    const projectId = await sc.project(dir);
    const { branches } = await sc.client.call<{ branches: Branch[] }>("git.branches", {
      projectId,
    });
    expect(branches).toEqual([
      { name: "main", current: true, isDefault: true, isRemote: false, upstream: null },
      { name: "older", current: false, isDefault: false, isRemote: false, upstream: null },
    ]);
    expect(
      await sc.client.call<ProjectStatus>("git.checkout", { projectId, branch: "older" }),
    ).toMatchObject({ branch: "older" });
    expect(git(dir, "branch", "--show-current").trim()).toBe("older");
    expect(
      await sc.client.call<ProjectStatus>("git.checkout", {
        projectId,
        branch: "feature/new",
        create: true,
      }),
    ).toMatchObject({ branch: "feature/new" });
    expect(git(dir, "branch", "--show-current").trim()).toBe("feature/new");
  });

  it("refuses invalid and unknown branches", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    await expect(
      sc.client.call("git.checkout", { projectId, branch: "bad..name", create: true }),
    ).rejects.toMatchObject({ code: "BRANCH_INVALID" });
    await expect(
      sc.client.call("git.checkout", { projectId, branch: "--force", create: true }),
    ).rejects.toMatchObject({ code: "BRANCH_INVALID" });
    await expect(
      sc.client.call("git.checkout", { projectId, branch: "missing" }),
    ).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
  });

  it("reports git's own refusal, e.g. a checkout that would lose changes", async () => {
    const dir = repository();
    git(dir, "switch", "--quiet", "--create", "other");
    write(dir, "README.md", "changed on other\n");
    git(dir, "commit", "--quiet", "-am", "other");
    git(dir, "switch", "--quiet", "main");
    write(dir, "README.md", "local edit\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    await expect(
      sc.client.call("git.checkout", { projectId, branch: "other" }),
    ).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect(git(dir, "branch", "--show-current").trim()).toBe("main");
  });
});

describe("jhin.source-control: a thread's branch", () => {
  it("records the branch checked out when the thread is created", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await sc.until(threadEvent(thread.id, (record) => record.branch === "main"));
    expect((await sc.status(projectId)).threads).toEqual([
      { threadId: thread.id, projectId, branch: "main", at: expect.any(String) },
    ]);
  });

  it("follows the checkout when a turn starts, and keeps it when another thread moves", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await sc.until(threadEvent(thread.id, (record) => record.branch === "main"));
    // Checked out from a terminal, then the thread runs a turn there.
    git(dir, "switch", "--quiet", "--create", "work");
    await sc.client.call("threads.send", { threadId: thread.id, text: "hello" });
    await sc.until(threadEvent(thread.id, (record) => record.branch === "work"));
    const read = await sc.client.call<{ checkedOut: boolean; thread: { branch: string } }>(
      "git.thread.status",
      { threadId: thread.id },
    );
    expect(read).toMatchObject({ checkedOut: true, thread: { branch: "work" } });
    // Back on main without a turn: the thread stays on its branch, no longer checked out.
    git(dir, "switch", "--quiet", "main");
    expect(
      await sc.client.call("git.thread.status", { threadId: thread.id, refresh: true }),
    ).toMatchObject({ checkedOut: false, thread: { branch: "work" } });
  });

  it("moves a thread with the branch it checks out", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await sc.until(threadEvent(thread.id, (record) => record.branch === "main"));
    await sc.client.call("git.checkout", {
      projectId,
      branch: "topic",
      create: true,
      threadId: thread.id,
    });
    await sc.until(threadEvent(thread.id, (record) => record.branch === "topic"));
  });

  it("forgets a deleted thread", async () => {
    const dir = repository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await sc.until(threadEvent(thread.id, () => true));
    await sc.client.call("threads.delete", { threadId: thread.id });
    await sc.until(
      (event) =>
        event.type === "source-control.thread.removed" &&
        (event.payload as { threadId: string }).threadId === thread.id,
    );
    expect((await sc.status(projectId)).threads).toEqual([]);
  });
});

describe("jhin.source-control: parsing git's output", () => {
  it("reads porcelain v2 status with renames, conflicts and a detached HEAD", () => {
    const output = [
      "# branch.oid 0123456789abcdef",
      "# branch.head (detached)",
      "1 .M N... 100644 100644 100644 aaa bbb file with space.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.ts",
      "old.ts",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
      "? untracked.txt",
      "",
    ].join("\0");
    expect(parseStatus(output)).toEqual({
      head: { branch: null, unborn: false, upstream: null, ahead: 0, behind: 0 },
      entries: [
        { path: "file with space.ts", status: "modified" },
        { path: "new.ts", previousPath: "old.ts", status: "renamed" },
        { path: "conflict.ts", status: "conflicted" },
        { path: "untracked.txt", status: "untracked" },
      ],
    });
  });

  it("reads numstat with renames and binary files", () => {
    const output = ["3\t1\tsrc/a.ts", "0\t0\t", "old.ts", "new.ts", "-\t-\timage.png", ""].join(
      "\0",
    );
    expect(parseNumstat(output)).toEqual([
      { path: "src/a.ts", insertions: 3, deletions: 1, binary: false },
      { path: "new.ts", previousPath: "old.ts", insertions: 0, deletions: 0, binary: false },
      { path: "image.png", insertions: 0, deletions: 0, binary: true },
    ]);
  });
});
