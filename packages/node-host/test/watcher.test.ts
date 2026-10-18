import * as Fs from "node:fs";
import * as Path from "node:path";

import { noopLogger } from "@jhin/kernel";
import type { Disposable } from "@jhin/sdk";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildOutputFilter, watch } from "../src/watcher.ts";
import { tempDir } from "./support/harness.ts";

interface WatchedPlugin {
  readonly root: string;
  /** The first burst of changes the watcher reports. */
  readonly firstBurst: Promise<readonly string[]>;
  /** Resolves once the watcher received a change to `relative` and dropped it. */
  ignored(relative: string): Promise<void>;
}

/** A plugin root with src/ and dist/, watched the way the node host watches plugins. */
function watchPlugin(entry: string): WatchedPlugin {
  const root = tempDir("watch");
  Fs.mkdirSync(Path.join(root, "src"));
  Fs.mkdirSync(Path.join(root, "dist"));
  const filter = buildOutputFilter(entry);
  const dropped = new Set<string>();
  const waiting = new Map<string, () => void>();
  const firstBurst = new Promise<readonly string[]>((resolve) => {
    watcher = watch(
      [
        {
          path: root,
          ...(filter === undefined ? {} : { filter }),
          onChange: resolve,
          onIgnored: (relative) => {
            dropped.add(relative);
            waiting.get(relative)?.();
          },
        },
      ],
      noopLogger,
    );
  });
  return {
    root,
    firstBurst,
    ignored: (relative) =>
      dropped.has(relative)
        ? Promise.resolve()
        : new Promise((resolve) => waiting.set(relative, resolve)),
  };
}

let watcher: Disposable | undefined;
afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
});

describe("plugin watching", () => {
  for (const output of ["dist", ".dist-next"]) {
    it(`drops ${output}/ changes of a plugin that runs from TypeScript source`, async () => {
      const plugin = watchPlugin("src/index.ts");
      Fs.mkdirSync(Path.join(plugin.root, output), { recursive: true });
      const built = Path.join(output, "index.js");

      Fs.writeFileSync(Path.join(plugin.root, built), "export default {};\n");
      // The change reached the watcher and was dropped, so it can join no burst. Had it
      // counted, it would start a burst instead, and the test fails on it at once.
      await Promise.race([
        plugin.ignored(built),
        plugin.firstBurst.then((files) => {
          throw new Error(`${output}/ change reported: ${files.join(", ")}`);
        }),
      ]);
      Fs.writeFileSync(Path.join(plugin.root, "src", "index.ts"), "export default {};\n");

      expect(await plugin.firstBurst).toEqual([Path.join(plugin.root, "src", "index.ts")]);
    });
  }

  it("reloads on the build output of a plugin whose entry is JavaScript, wherever it is", async () => {
    for (const entry of ["dist/index.js", "build/index.mjs", "index.js"]) {
      expect(buildOutputFilter(entry)).toBeUndefined();
    }
    const plugin = watchPlugin("dist/index.js");
    Fs.writeFileSync(Path.join(plugin.root, "dist", "index.js"), "export default {};\n");

    expect(await plugin.firstBurst).toContain(Path.join(plugin.root, "dist", "index.js"));
  });
});
