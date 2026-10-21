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
      commands: [{ name: "review", description: "Review the changes", input: { hint: "<path>" } }],
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

  it("reads a mentioned file of a project and a skill's instructions, nothing else (D1003, D1004)", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "app");
    write(dir, ["src/main.ts"]);
    Fs.writeFileSync(Path.join(dir, "src", "main.ts"), "export const answer = 42;\n");
    Fs.writeFileSync(Path.join(data, "secret.txt"), "keep");
    Fs.symlinkSync(Path.join(data, "secret.txt"), Path.join(dir, "linked.txt"));
    const project = await client.call<{ id: string }>("projects.create", { path: dir });
    const decode = (head: { data: string }) => Buffer.from(head.data, "base64").toString("utf8");

    const read = await client.call<{ data: string; sizeBytes: number; truncated: boolean }>(
      "projects.read-file",
      { projectId: project.id, path: "src/main.ts" },
    );
    expect(decode(read)).toBe("export const answer = 42;\n");
    expect(read).toMatchObject({ sizeBytes: 26, truncated: false });
    // Only the start, when asked for less.
    const head = await client.call<{ data: string; truncated: boolean }>("projects.read-file", {
      projectId: project.id,
      path: "src/main.ts",
      maxBytes: 6,
    });
    expect([decode(head), head.truncated]).toEqual(["export", true]);
    for (const path of ["../secret.txt", Path.join(data, "secret.txt"), "linked.txt", "src"]) {
      await expect(
        client.call("projects.read-file", { projectId: project.id, path }),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
    }
    await expect(
      client.call("projects.read-file", { projectId: project.id, path: "gone.ts" }),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });

    // The test runtime's skill `deploy` points at its SKILL.md; another name reads nothing.
    write(dir, [".claude/skills/deploy/SKILL.md"]);
    Fs.writeFileSync(Path.join(dir, ".claude", "skills", "deploy", "SKILL.md"), "# Deploy\n");
    expect(
      decode(
        await client.call<{ data: string }>("agents.skill.read", {
          projectId: project.id,
          name: "deploy",
        }),
      ),
    ).toBe("# Deploy\n");
    await expect(
      client.call("agents.skill.read", { projectId: project.id, name: "other" }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });
});
