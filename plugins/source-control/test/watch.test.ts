import * as Fs from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { watchTree } from "../src/watch.ts";
import { temp } from "./support.ts";

/** A watcher of `root` ignoring the directories named in `ignored`. */
function watcher(root: string, ignored: readonly string[]) {
  const changes: (() => void)[] = [];
  const watches = new Map<string, () => void>();
  const tree = watchTree({
    root,
    gitDirs: [Path.join(root, ".git")],
    isIgnored: async (paths) =>
      new Set(paths.filter((path) => ignored.includes(Path.relative(root, path)))),
    onChange: () => {
      for (const resolve of changes.splice(0)) resolve();
    },
    onWatch: (dir) => watches.get(Path.relative(root, dir))?.(),
  });
  return {
    tree,
    /** Resolves on the next change. */
    next: () => new Promise<void>((resolve) => changes.push(resolve)),
    /** Resolves once `dir` (relative) is watched. */
    watched: (dir: string) => new Promise<void>((resolve) => watches.set(dir, resolve)),
  };
}

describe("jhin.source-control: watching a working tree", () => {
  it("watches every directory git does not ignore, and the git directory's refs", async () => {
    const root = temp("jhin-sc-watch-");
    for (const dir of [".git/refs/heads", "src/deep", "node_modules/pkg/lib", "build"]) {
      Fs.mkdirSync(Path.join(root, dir), { recursive: true });
    }
    const { tree } = watcher(root, ["node_modules", "build"]);
    await tree.ready;
    expect(tree.directories().map((dir) => Path.relative(root, dir) || ".")).toEqual(
      [".", ".git", ".git/refs", ".git/refs/heads", "src", "src/deep"].toSorted(),
    );
    tree.dispose();
    expect(tree.directories()).toEqual([]);
  });

  it("watches a directory created later, unless git ignores it", async () => {
    const root = temp("jhin-sc-watch-");
    Fs.mkdirSync(Path.join(root, ".git"));
    const { tree, next, watched } = watcher(root, ["dist"]);
    await tree.ready;
    // dist is created first: had it been watched, it would come before lib.
    const lib = watched("lib");
    const dist = watched("dist");
    Fs.mkdirSync(Path.join(root, "dist"));
    Fs.mkdirSync(Path.join(root, "lib"));
    await lib;
    void dist.then(() => expect.fail("dist is ignored"));
    // A write inside the new directory is seen.
    const changed = next();
    Fs.writeFileSync(Path.join(root, "lib", "a.ts"), "a\n");
    await changed;
    expect(tree.directories().map((dir) => Path.relative(root, dir) || ".")).toEqual([
      ".",
      ".git",
      "lib",
    ]);
    tree.dispose();
  });

  it("stops at its limit of directories", async () => {
    const root = temp("jhin-sc-watch-");
    for (const name of ["a", "b", "c", "d"]) Fs.mkdirSync(Path.join(root, name));
    const tree = watchTree({
      root,
      gitDirs: [],
      isIgnored: async () => new Set(),
      onChange: () => undefined,
      maxDirectories: 3,
    });
    await tree.ready;
    expect(tree.directories()).toHaveLength(3);
    tree.dispose();
  });
});
