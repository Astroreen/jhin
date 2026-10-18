import * as Fs from "node:fs";
import * as Path from "node:path";

import { noopLogger } from "@jhin/kernel";
import type { Disposable } from "@jhin/sdk";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildOutputFilter, watch } from "../src/watcher.ts";
import { tempDir } from "./support/harness.ts";

/** A plugin root with src/ and dist/; resolves with the first burst of changes it reports. */
function watchPlugin(entry: string): { root: string; firstBurst: Promise<readonly string[]> } {
  const root = tempDir("watch");
  Fs.mkdirSync(Path.join(root, "src"));
  Fs.mkdirSync(Path.join(root, "dist"));
  const filter = buildOutputFilter(entry);
  const firstBurst = new Promise<readonly string[]>((resolve) => {
    watcher = watch(
      [{ path: root, ...(filter === undefined ? {} : { filter }), onChange: resolve }],
      noopLogger,
    );
  });
  return { root, firstBurst };
}

let watcher: Disposable | undefined;
afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
});

describe("plugin watching", () => {
  it("ignores dist/ of a plugin that runs from source", async () => {
    const { root, firstBurst } = watchPlugin("src/index.ts");
    // dist/ is written first: had it counted, it would be in the first burst.
    Fs.writeFileSync(Path.join(root, "dist", "index.js"), "export default {};\n");
    Fs.writeFileSync(Path.join(root, "src", "index.ts"), "export default {};\n");

    expect(await firstBurst).toEqual([Path.join(root, "src", "index.ts")]);
  });

  it("reloads on dist/ of a plugin that runs from built JavaScript", async () => {
    const { root, firstBurst } = watchPlugin("dist/index.js");
    Fs.writeFileSync(Path.join(root, "dist", "index.js"), "export default {};\n");

    expect(await firstBurst).toContain(Path.join(root, "dist", "index.js"));
  });
});
