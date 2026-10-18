// Builds the package in the current directory: a clean dist/ from src/.
//
//   node ../../scripts/build.ts   (a package's "build" and "prepack" scripts)
//
// tsc does not clean its outDir, so output of a renamed or deleted source file
// would stay in dist/ and be packed (`files: ["dist"]`).

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";

Fs.rmSync("dist", { recursive: true, force: true });
const result = ChildProcess.spawnSync("tsc", ["-p", "tsconfig.build.json"], {
  stdio: "inherit",
  // On Windows the binary is tsc.cmd, which only a shell resolves.
  shell: process.platform === "win32",
});
process.exitCode = result.status ?? 1;
