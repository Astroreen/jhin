// Builds the package in the current directory: a clean dist/ from src/.
//
//   node ../../scripts/build.ts   (a package's "build" and "prepack" scripts)
//
// tsc does not clean its outDir, so output of a renamed or deleted source file
// would stay in dist/ and be packed (`files: ["dist"]`).

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

// The workspace's own TypeScript, whether or not node_modules/.bin is on PATH.
const windows = process.platform === "win32";
const tsc = Path.join(
  import.meta.dirname,
  "..",
  "node_modules",
  ".bin",
  windows ? "tsc.cmd" : "tsc",
);
if (!Fs.existsSync(tsc)) throw new Error(`${tsc} is missing: run pnpm install first`);

// Only a package directory gets its dist/ removed.
if (!Fs.existsSync("tsconfig.build.json")) {
  throw new Error(`${Path.resolve("tsconfig.build.json")} is missing: run this in a package`);
}
// Built into a fresh directory first: a failed build keeps the previous dist/.
const next = ".dist-next";
Fs.rmSync(next, { recursive: true, force: true });
const result = ChildProcess.spawnSync(tsc, ["-p", "tsconfig.build.json", "--outDir", next], {
  stdio: "inherit",
  // A .cmd shim runs only through a shell.
  shell: windows,
});
if (result.error !== undefined) throw result.error;
if (result.status === 0) {
  // Not atomic: dist/ is missing for a moment between the two calls (Deferred in
  // the plan). Watchers ignore .dist-next/; a plugin run from source also ignores
  // dist/, one run from dist/ reloads on the swap.
  Fs.rmSync("dist", { recursive: true, force: true });
  Fs.renameSync(next, "dist");
} else {
  Fs.rmSync(next, { recursive: true, force: true });
}
process.exitCode = result.status ?? 1;
