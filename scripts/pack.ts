// Packs one workspace package into a tarball whose manifest names built JavaScript.
//
//   node scripts/pack.ts <package-dir> <out.tgz>
//   node ../../scripts/pack.ts guard      (a plugin's "prepack": refuses a bare `pnpm pack`)
//
// In the workspace a plugin's `jhin.entry` is TypeScript (src/index.ts), run by
// Node directly and hot reloaded (D14). Node does not strip types under
// node_modules, so the packed manifest must name the built file instead. pnpm
// applies `publishConfig` to standard fields (`exports`, `bin`) and resolves
// `workspace:` and `catalog:` specs, but leaves `jhin` alone. This runs
// `pnpm pack` (whose "prepack" builds dist/), then merges `publishConfig.jhin`
// into `jhin` inside the produced tarball. Files of the workspace are never
// rewritten: a node running `serve --watch` from this checkout reloads on
// manifest changes (D14).

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

const STAGED = "JHIN_PACK_STAGED";

function run(command: string, args: readonly string[], cwd: string, env = process.env): void {
  const result = ChildProcess.spawnSync(command, args, {
    cwd,
    env,
    // stdout too: callers may reserve their own stdout for results.
    stdio: ["ignore", process.stderr, process.stderr],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} (in ${cwd}) exited with ${result.status}`);
  }
}

interface PackedManifest {
  jhin?: Record<string, unknown>;
  publishConfig?: { jhin?: Record<string, unknown> } & Record<string, unknown>;
}

/** The manifest the tarball should carry: `publishConfig.jhin` applied to `jhin`. */
function packedManifest(manifest: PackedManifest): PackedManifest {
  const { jhin: override, ...publishConfig } = manifest.publishConfig ?? {};
  if (override === undefined) return manifest;
  if (manifest.jhin === undefined) throw new Error('"publishConfig.jhin" without "jhin"');
  const packed: PackedManifest = { ...manifest, jhin: { ...manifest.jhin, ...override } };
  if (Object.keys(publishConfig).length > 0) packed.publishConfig = publishConfig;
  else delete packed.publishConfig;
  return packed;
}

function pack(dir: string, out: string): void {
  const stage = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-pack-stage-"));
  try {
    const raw = Path.join(stage, "raw.tgz");
    run("pnpm", ["pack", "--out", raw], dir, { ...process.env, [STAGED]: "1" });
    run("tar", ["-xzf", raw, "-C", stage], stage);
    const file = Path.join(stage, "package", "package.json");
    const manifest = JSON.parse(Fs.readFileSync(file, "utf8")) as PackedManifest;
    Fs.writeFileSync(file, `${JSON.stringify(packedManifest(manifest), null, 2)}\n`);
    Fs.mkdirSync(Path.dirname(out), { recursive: true });
    // Files only, like npm and pnpm tarballs (no directory entries).
    const files = Fs.readdirSync(Path.join(stage, "package"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => Path.relative(stage, Path.join(entry.parentPath, entry.name)))
      .toSorted();
    run("tar", ["-czf", out, "-C", stage, ...files], stage);
  } finally {
    Fs.rmSync(stage, { recursive: true, force: true });
  }
}

const [first, second] = process.argv.slice(2);
if (first === "guard") {
  if (process.env[STAGED] !== "1") {
    throw new Error(
      "a bare `pnpm pack` would ship a plugin manifest naming TypeScript: " +
        "run `node scripts/pack.ts <package-dir> <out.tgz>` from the repository root",
    );
  }
} else if (first !== undefined && second !== undefined) {
  pack(Path.resolve(first), Path.resolve(second));
} else {
  throw new Error("usage: pack.ts <package-dir> <out.tgz> | pack.ts guard");
}
