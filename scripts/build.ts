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

Fs.rmSync("dist", { recursive: true, force: true });
const result = ChildProcess.spawnSync(tsc, ["-p", "tsconfig.build.json"], {
  stdio: "inherit",
  // A .cmd shim runs only through a shell.
  shell: windows,
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
