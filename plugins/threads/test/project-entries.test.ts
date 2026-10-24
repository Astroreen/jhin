import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createProjectEntries, entriesOf, rankEntries } from "../src/project-entries.ts";
import { node } from "./support.ts";

const write = (root: string, files: string[]) => {
  for (const file of files) {
    Fs.mkdirSync(Path.dirname(Path.join(root, file)), { recursive: true });
    Fs.writeFileSync(Path.join(root, file), "x");
  }
};

describe("jhin.threads: project files for @ mentions (D302)", () => {
  it("ranks names before paths, exact before prefix before fuzzy", () => {
    const { entries } = entriesOf([
      "src/components/ComposerMenu.tsx",
      "src/composer.ts",
      "docs/composition.md",
      "src/lib/compose-utils.ts",
    ]);
    // The exact name first; a fuzzy match of it (ComposerMenu.tsx) after.
    expect(rankEntries(entries, "composer.ts", 10).map((entry) => entry.path)).toEqual([
      "src/composer.ts",
      "src/components/ComposerMenu.tsx",
    ]);
    // Prefixes of the name, shorter names first; a tie goes to the path's order.
    expect(rankEntries(entries, "compos", 4).map((entry) => entry.path)).toEqual([
      "src/composer.ts",
      "docs/composition.md",
      "src/components/ComposerMenu.tsx",
      "src/lib/compose-utils.ts",
    ]);
    expect(rankEntries(entries, "cmpmnu", 5).map((entry) => entry.path)).toEqual([
      "src/components/ComposerMenu.tsx",
    ]);
    // Folders are entries too; a kind keeps one of them; `@./` is not part of the query.
    expect(rankEntries(entries, "@./src", 3, "directory").map((entry) => entry.path)).toEqual([
      "src",
      "src/lib",
      "src/components",
    ]);
  });

  it("keeps at most the limit of entries and says it was cut", () => {
    const { entries, truncated } = entriesOf(["a/1", "a/2", "b/3"], 3);
    expect(entries.map((entry) => entry.path)).toEqual(["a", "a/1", "a/2"]);
    expect(truncated).toBe(true);
  });

  it("lists what git lists, not what it ignores, and walks a folder without git", async () => {
    const repo = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-entries-"));
    write(repo, ["src/app.ts", "build/out.js", ".gitignore"]);
    Fs.writeFileSync(Path.join(repo, ".gitignore"), "build/\n");
    ChildProcess.execFileSync("git", ["init", "-q"], { cwd: repo });
    // A tracked file deleted from the working tree is no longer offered.
    write(repo, ["src/gone.ts"]);
    ChildProcess.execFileSync("git", ["add", "src/gone.ts"], { cwd: repo });
    Fs.rmSync(Path.join(repo, "src", "gone.ts"));
    const entries = createProjectEntries();
    const found = await entries.search(repo, "", { limit: 50 });
    expect(found.entries.map((entry) => entry.path).toSorted()).toEqual([
      ".gitignore",
      "src",
      "src/app.ts",
    ]);

    const plain = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-entries-"));
    write(plain, ["notes/todo.md", "node_modules/x/index.js"]);
    expect(
      (await entries.search(plain, "todo", { limit: 5 })).entries.map((entry) => entry.path),
    ).toEqual(["notes/todo.md"]);
  });

  it("searches a project through the command and lists an agent's commands and skills", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "app");
    write(dir, ["src/main.ts", "README.md"]);
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    expect(
      await client.call("projects.search-entries", { projectId: project.id, query: "main" }),
    ).toEqual({ entries: [{ path: "src/main.ts", kind: "file" }], truncated: false });
    expect(
      await client.call("projects.search-entries", {
        projectId: project.id,
        query: "",
        limit: 1,
      }),
    ).toMatchObject({ truncated: true });

    expect(await client.call("agents.commands", { projectId: project.id })).toEqual({
      // T3's `/usage-limits` comes first for an agent with usage limits (providers.md D1144).
      commands: [
        { name: "usage-limits", description: "Show this provider's usage limits" },
        { name: "review", description: "Review the changes", input: { hint: "<path>" } },
      ],
      skills: [
        {
          name: "deploy",
          description: "Deploy the app",
          path: `${dir}/.claude/skills/deploy/SKILL.md`,
          scope: "project",
        },
      ],
    });
    await expect(
      client.call("agents.commands", { projectId: project.id, agentId: "acme.none" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  const decode = (head: { data: string }) => Buffer.from(head.data, "base64").toString("utf8");

  it("reads the start of a project's file, or all of it or nothing (D1003)", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "app");
    write(dir, ["src/main.ts", "empty.txt"]);
    Fs.writeFileSync(Path.join(dir, "src", "main.ts"), "export const answer = 42;\n");
    Fs.writeFileSync(Path.join(dir, "empty.txt"), "");
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    const read = (input: Record<string, unknown>) =>
      client.call<{ data: string; sizeBytes: number; truncated: boolean }>("projects.read-file", {
        projectId: project.id,
        ...input,
      });

    const whole = await read({ path: "src/main.ts" });
    expect([decode(whole), whole.sizeBytes, whole.truncated]).toEqual([
      "export const answer = 42;\n",
      26,
      false,
    ]);
    const head = await read({ path: "src/main.ts", maxBytes: 6 });
    expect([decode(head), head.truncated]).toEqual(["export", true]);
    // `whole`: a file past the limit is refused before it is read.
    await expect(read({ path: "src/main.ts", maxBytes: 6, whole: true })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
      details: { sizeBytes: 26 },
    });
    expect(await read({ path: "empty.txt" })).toMatchObject({ data: "", sizeBytes: 0 });
    await expect(read({ path: "gone.ts" })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("never reads outside the project, nor says what is there", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "app");
    write(dir, ["src/main.ts"]);
    Fs.writeFileSync(Path.join(data, "secret.txt"), "keep");
    Fs.symlinkSync(Path.join(data, "secret.txt"), Path.join(dir, "linked.txt"));
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    for (const path of [
      "../secret.txt",
      // Missing outside answers as an existing one does: no probing the host's files.
      "../missing.txt",
      Path.join(data, "secret.txt"),
      "linked.txt",
      "src",
      ".",
    ]) {
      await expect(
        client.call("projects.read-file", { projectId: project.id, path }),
        path,
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
    }
  });

  it("reads in a thread's worktree, and only for a thread of the project", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "app");
    const worktree = Path.join(data, "app-feature");
    write(dir, ["a.txt"]);
    write(worktree, ["a.txt"]);
    Fs.writeFileSync(Path.join(dir, "a.txt"), "main");
    Fs.writeFileSync(Path.join(worktree, "a.txt"), "feature");
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    Fs.mkdirSync(Path.join(data, "other"));
    const other = await client.call<{ id: string }>("projects.create", {
      path: Path.join(data, "other"),
    });
    const thread = await client.call<{ id: string }>("threads.create", {
      projectId: project.id,
      worktreePath: worktree,
    });
    const foreign = await client.call<{ id: string }>("threads.create", { projectId: other.id });

    expect(
      decode(
        await client.call<{ data: string }>("projects.read-file", {
          projectId: project.id,
          threadId: thread.id,
          path: "a.txt",
        }),
      ),
    ).toBe("feature");
    await expect(
      client.call("projects.read-file", {
        projectId: project.id,
        threadId: foreign.id,
        path: "a.txt",
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("reads a skill's instructions, only of a skill the agent offers (D1004)", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "app");
    write(dir, ["README.md"]);
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    const skill = (input: Record<string, unknown>) =>
      client.call<{ data: string }>("agents.skill.read", { projectId: project.id, ...input });

    // The fake agent's skill `deploy` names a SKILL.md that is not there yet.
    await expect(skill({ name: "deploy" })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    write(dir, [".claude/skills/deploy/SKILL.md"]);
    Fs.writeFileSync(Path.join(dir, ".claude", "skills", "deploy", "SKILL.md"), "# Deploy\n");
    expect(decode(await skill({ name: "deploy" }))).toBe("# Deploy\n");
    await expect(skill({ name: "other" })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    await expect(skill({ name: "deploy", agentId: "acme.none" })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    // A SKILL.md that is a link to another file reads nothing.
    Fs.writeFileSync(Path.join(data, "secret.txt"), "keep");
    Fs.rmSync(Path.join(dir, ".claude", "skills", "deploy", "SKILL.md"));
    Fs.symlinkSync(
      Path.join(data, "secret.txt"),
      Path.join(dir, ".claude", "skills", "deploy", "SKILL.md"),
    );
    await expect(skill({ name: "deploy" })).rejects.toMatchObject({ code: "PATH_NOT_SKILL" });
  });
});

describe("jhin.threads: the checked-in t3.json (source-control.md D1465)", () => {
  it("reads T3's project file, leniently, and says why one is no project file", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "app");
    Fs.mkdirSync(dir, { recursive: true });
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    const read = () =>
      client.call<{ file: unknown; error?: string }>("projects.t3-file.get", {
        projectId: project.id,
      });

    expect(await read()).toEqual({ file: null });
    // T3's own file: comments, a trailing comma and keys it does not know.
    Fs.writeFileSync(
      Path.join(dir, "t3.json"),
      [
        "{",
        '  "$schema": "https://t3.codes/schema/t3.json",',
        "  // shared with the team",
        '  "scripts": [{ "name": " Dev ", "command": "pnpm dev", "previewUrl": "http://localhost:5173" },],',
        '  "worktreeSubmodules": "top-level",',
        '  "later": true,',
        "}",
      ].join("\n"),
    );
    expect(await read()).toEqual({
      file: {
        $schema: "https://t3.codes/schema/t3.json",
        scripts: [{ name: "Dev", command: "pnpm dev", previewUrl: "http://localhost:5173" }],
        worktreeSubmodules: "top-level",
      },
    });

    Fs.writeFileSync(Path.join(dir, "t3.json"), '{ "scripts": [{ "name": "" }] }');
    expect(await read()).toMatchObject({
      file: null,
      error: expect.stringMatching(/^t3\.json is not a T3 project file at scripts\.0\.name/),
    });
    Fs.writeFileSync(Path.join(dir, "t3.json"), "{ nope");
    expect(await read()).toMatchObject({ file: null, error: expect.stringMatching(/not JSON/) });
  });
});
