// The file explorer's listing of one folder (t3-parity.md D1428), as T3's WorkspaceEntries.list.
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { listFolder } from "../src/project-entries.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) Fs.rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>, git: boolean): string {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-list-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    Fs.mkdirSync(Path.dirname(Path.join(root, file)), { recursive: true });
    Fs.writeFileSync(Path.join(root, file), text);
  }
  if (git) ChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

const sorted = <T extends { path: string }>(entries: readonly T[]) =>
  entries.toSorted((a, b) => a.path.localeCompare(b.path));

describe("jhin.threads: listing a project's folder (D1428)", () => {
  it("lists a folder's own files and folders, ignored ones marked, never .git", async () => {
    const root = project(
      { ".gitignore": "dist\n", "src/a.ts": "a", "src/lib/b.ts": "b", "dist/out.js": "x" },
      true,
    );
    expect(sorted(await listFolder(root, ""))).toEqual([
      { path: ".gitignore", kind: "file" },
      { path: "dist", kind: "directory", ignored: true },
      { path: "src", kind: "directory" },
    ]);
    expect(sorted(await listFolder(root, "src"))).toEqual([
      { path: "src/a.ts", kind: "file" },
      { path: "src/lib", kind: "directory" },
    ]);
    await expect(listFolder(root, ".git")).rejects.toThrow("FOLDER_OUTSIDE");
    await expect(listFolder(root, ".GIT/objects")).rejects.toThrow("FOLDER_OUTSIDE");
  });

  it("lists without git, and refuses a link out of the project", async () => {
    const root = project({ "a.txt": "a" }, false);
    const outside = project({ "secret.txt": "s" }, false);
    Fs.symlinkSync(outside, Path.join(root, "out"));
    expect(await listFolder(root, "")).toContainEqual({ path: "a.txt", kind: "file" });
    await expect(listFolder(root, "out")).rejects.toThrow("FOLDER_OUTSIDE");
    await expect(listFolder(root, "../x")).rejects.toThrow("FOLDER_OUTSIDE");
  });
});
