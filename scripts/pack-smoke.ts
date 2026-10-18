// Proves the packed CLI runs from node_modules, where Node does not strip TypeScript.
//
//   node scripts/pack-smoke.ts          pack, install, run, clean up
//   node scripts/pack-smoke.ts --keep   keep the temporary directory for inspection
//
// Packs `jhin-ai` and every workspace package it depends on with scripts/pack.ts
// (`pnpm pack` builds each package through "prepack"; no workspace file is
// rewritten, which this checks after every package), installs the tarballs into a fresh
// directory outside the workspace and runs the installed `jhin`: `help`,
// `inspect`, a command, then `serve --ui` with a remote `inspect` and a request
// for the web client. Needs the npm registry for third-party dependencies.

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { lockedPins } from "./packing.ts";

const ROOT = Path.resolve(import.meta.dirname, "..");
const CLI = "jhin-ai";
const keep = process.argv.includes("--keep");

interface Manifest {
  readonly name: string;
  readonly packageManager?: string;
  readonly dependencies?: Record<string, string>;
}

const readJson = <T>(file: string): T => JSON.parse(Fs.readFileSync(file, "utf8")) as T;

function step(text: string): void {
  process.stdout.write(`\n== ${text}\n`);
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = ChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    // On Windows pnpm and the installed jhin are .cmd shims, which only a shell resolves.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}`);
  }
  return result.stdout;
}

/** Workspace package directories by package name. */
function workspacePackages(): Map<string, string> {
  const packages = new Map<string, string>();
  for (const parent of ["packages", "plugins", "apps"]) {
    for (const child of Fs.readdirSync(Path.join(ROOT, parent))) {
      const file = Path.join(ROOT, parent, child, "package.json");
      if (Fs.existsSync(file)) packages.set(readJson<Manifest>(file).name, Path.dirname(file));
    }
  }
  return packages;
}

/** The CLI and every workspace package it needs at runtime (`dependencies` only). */
function closure(packages: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  const visit = (name: string) => {
    if (found.has(name)) return;
    found.add(name);
    const manifest = readJson<Manifest>(Path.join(packages.get(name)!, "package.json"));
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec.startsWith("workspace:")) visit(dep);
    }
  };
  visit(CLI);
  return [...found].toSorted();
}

/**
 * `git status`, contents and modification time of every workspace package.json.
 * The time catches a rewrite that was undone before the check, which a node
 * watching the checkout would still have reloaded on.
 */
function manifestState(packages: ReadonlyMap<string, string>): string {
  const files = [...packages.values()].map((dir) => Path.join(dir, "package.json")).toSorted();
  const status = run("git", ["status", "--porcelain", "--", ...files], ROOT);
  const states = files.map(
    (file) =>
      `${file} ${Fs.statSync(file, { bigint: true }).mtimeNs} ${Fs.readFileSync(file, "utf8")}`,
  );
  return [status, ...states].join("\0");
}

function untouched(before: string, when: string): void {
  if (manifestState(workspacePackages()) !== before) {
    const status = run("git", ["status", "--porcelain"], ROOT);
    throw new Error(`workspace package.json files changed ${when}:\n${status}`);
  }
}

/** Starts `jhin serve --ui`; resolves once it printed its RPC, UI and log lines, in any order. */
function serve(
  bin: string,
  dir: string,
): Promise<{
  child: ChildProcess.ChildProcess;
  output: string;
  rpc: string;
  ui: string;
  exited: Promise<number | null>;
}> {
  const child = ChildProcess.spawn(bin, ["serve", "--ui", "--home", dir, "--cwd", dir], {
    stdio: ["ignore", "inherit", "pipe"],
  });
  // Registered before anything else happens, so no exit can be missed.
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return new Promise((resolve, reject) => {
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
      process.stderr.write(chunk);
      // Whole lines only: a chunk may end in the middle of one.
      const rpc = /^rpc: (\S+)\n/m.exec(output)?.[1];
      const ui = /^ui: (\S+)\n/m.exec(output)?.[1];
      if (rpc !== undefined && ui !== undefined && /^logs: .+\n/m.test(output)) {
        resolve({ child, output, rpc, ui, exited });
      }
    });
    // Before the endpoints are printed an exit is a failure; after, resolve() already won.
    void exited.then((code) => reject(new Error(`jhin serve exited with ${code}:\n${output}`)));
  });
}

/** Fails unless the tarball holds only dist/, package.json, LICENSE and README.md, and names no source. */
function checkTarball(file: string): void {
  const entries = run("tar", ["-tzf", file], ROOT).trim().split("\n");
  const stray = entries.filter(
    (entry) => !/^package\/(dist\/.+|LICENSE|README\.md|package\.json)$/.test(entry),
  );
  if (stray.length > 0) throw new Error(`${file} ships more than dist/: ${stray.join(", ")}`);
  const manifest = JSON.parse(run("tar", ["-xzOf", file, "package/package.json"], ROOT)) as {
    exports?: unknown;
    bin?: unknown;
    main?: unknown;
    module?: unknown;
    types?: unknown;
    typings?: unknown;
    jhin?: { entry?: unknown };
  };
  const pointers = JSON.stringify([
    manifest.exports,
    manifest.bin,
    manifest.main,
    manifest.module,
    manifest.types,
    manifest.typings,
    manifest.jhin?.entry,
  ]);
  // A path that starts in src/ or names TypeScript (declarations are fine).
  if (/"(\.\/)?src\/|\.tsx?"/.test(pointers.replaceAll('.d.ts"', '"'))) {
    throw new Error(`${file} points at source: ${pointers}`);
  }
}

async function main(): Promise<void> {
  const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-pack-"));
  try {
    const packages = workspacePackages();
    const names = closure(packages);

    step(`pack ${names.length} packages`);
    // Packing must never rewrite workspace manifests: `serve --watch` reloads on them (D14).
    const manifests = manifestState(packages);
    const tarballs = Path.join(tmp, "tarballs");
    const tarball = new Map<string, string>();
    for (const name of names) {
      const file = Path.join(tarballs, `${name.replace("@", "").replace("/", "-")}.tgz`);
      run("node", [Path.join(ROOT, "scripts", "pack.ts"), packages.get(name)!, file], ROOT);
      untouched(manifests, `after packing ${name}`);
      checkTarball(file);
      tarball.set(name, file);
      process.stdout.write(`${Path.basename(file)}\n`);
    }

    step(`install into ${Path.join(tmp, "app")}`);
    const app = Path.join(tmp, "app");
    Fs.mkdirSync(app);
    const root = readJson<Manifest>(Path.join(ROOT, "package.json"));
    Fs.writeFileSync(
      Path.join(app, "package.json"),
      JSON.stringify({
        name: "jhin-pack-smoke",
        private: true,
        packageManager: root.packageManager,
        dependencies: { [CLI]: `file:${tarball.get(CLI)}` },
      }),
    );
    // The workspace packages are not on the registry: every reference goes to its
    // tarball. Third-party packages get the versions the workspace lockfile has, so
    // an upstream release cannot change what this check installs.
    const locked = lockedPins(Fs.readFileSync(Path.join(ROOT, "pnpm-lock.yaml"), "utf8"));
    process.stdout.write(`${locked.pins.size} third-party versions pinned from pnpm-lock.yaml\n`);
    if (locked.unpinned.length > 0) {
      process.stdout.write(
        `left unpinned (several versions on one major, or not from the registry): ${locked.unpinned.join("; ")}\n`,
      );
    }
    const pins = new Map<string, string>([
      ...locked.pins,
      ...names
        .filter((name) => name !== CLI)
        .map((name): [string, string] => [name, `file:${tarball.get(name)}`]),
    ]);
    const overrides = [...pins].map(
      ([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`,
    );
    Fs.writeFileSync(
      Path.join(app, "pnpm-workspace.yaml"),
      `overrides:\n${overrides.join("\n")}\n`,
    );
    run("pnpm", ["install"], app);

    const bin = Path.join(app, "node_modules", ".bin", "jhin");
    const dir = Path.join(tmp, "node");
    Fs.mkdirSync(Path.join(dir, ".jhin"), { recursive: true });
    Fs.writeFileSync(
      Path.join(dir, ".jhin", "config.jsonc"),
      JSON.stringify({ "jhin.http": { port: 0 } }),
    );
    const at = ["--home", dir, "--cwd", dir];

    step("jhin help");
    const help = run(bin, ["help", ...at], tmp);
    if (!help.includes("host.inspect")) throw new Error(`jhin help lists no commands:\n${help}`);
    process.stdout.write(help);

    step("jhin inspect");
    const snapshot = JSON.parse(run(bin, ["inspect", ...at], tmp)) as {
      kernel: { plugins: { id: string; status: string; location: string }[] };
    };
    const plugins = snapshot.kernel.plugins;
    const installed = Path.join(Fs.realpathSync(app), "node_modules") + Path.sep;
    for (const plugin of plugins) {
      if (plugin.status !== "active") throw new Error(`not active: ${JSON.stringify(plugin)}`);
      // The host's own plugin has no package (host://jhin.host).
      if (plugin.location.includes("://")) {
        process.stdout.write(`active   ${plugin.id.padEnd(20)} ${plugin.location}\n`);
        continue;
      }
      const location = Fs.realpathSync(plugin.location);
      const { jhin } = readJson<{ jhin: { entry: string } }>(Path.join(location, "package.json"));
      if (!location.startsWith(installed) || jhin.entry !== "dist/index.js") {
        throw new Error(`${plugin.id} is not the packed plugin: ${location}, entry ${jhin.entry}`);
      }
      process.stdout.write(
        `active   ${plugin.id.padEnd(20)} ${Path.relative(installed, location)}/${jhin.entry}\n`,
      );
    }

    step("jhin example.greet --name Ada");
    process.stdout.write(run(bin, ["example.greet", "--name", "Ada", ...at], tmp));

    step("jhin serve --ui");
    const { child, output, rpc, ui, exited } = await serve(bin, dir);
    try {
      if (!output.includes(", 0 with problems")) throw new Error("jhin serve reported problems");

      step(`GET ${ui}`);
      const page = await fetch(ui);
      const html = await page.text();
      if (!page.ok || !html.includes("<script")) throw new Error(`web client: ${page.status}`);
      process.stdout.write(`${page.status} ${page.headers.get("content-type")}\n`);

      step(`jhin inspect --url ${rpc}`);
      const remote = JSON.parse(run(bin, ["inspect", "--url", rpc, "--home", dir], tmp)) as {
        nodeId: string;
        kernel: { plugins: unknown[] };
      };
      process.stdout.write(`node ${remote.nodeId}: ${remote.kernel.plugins.length} plugins\n`);
    } finally {
      child.kill("SIGTERM");
    }
    const code = await exited;
    if (code !== 0) throw new Error(`jhin serve exited with ${code}`);

    untouched(manifests, "at the end");
    step("ok: the packed CLI runs from node_modules; workspace manifests untouched");
  } finally {
    if (keep) process.stdout.write(`kept ${tmp}\n`);
    else Fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
