// Proves the packed CLI runs from node_modules, where Node does not strip TypeScript.
//
//   node scripts/pack-smoke.ts          pack, install, run, clean up
//   node scripts/pack-smoke.ts --keep   keep the temporary directory for inspection
//
// Packs `jhin-ai` and every workspace package it depends on (`pnpm pack` runs
// each package's build through "prepack"), installs the tarballs into a fresh
// directory outside the workspace and runs the installed `jhin`: `help`,
// `inspect`, a command, then `serve --ui` with a remote `inspect` and a request
// for the web client. Needs the npm registry for third-party dependencies.

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

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

/** Starts `jhin serve --ui` and resolves once it printed its endpoints. */
function serve(
  bin: string,
  dir: string,
): Promise<{ child: ChildProcess.ChildProcess; output: string }> {
  const child = ChildProcess.spawn(bin, ["serve", "--ui", "--home", dir, "--cwd", dir], {
    stdio: ["ignore", "inherit", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
      process.stderr.write(chunk);
      if (output.includes("logs:")) resolve({ child, output });
    });
    child.once("exit", (code) => reject(new Error(`jhin serve exited with ${code}`)));
  });
}

async function main(): Promise<void> {
  const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-pack-"));
  try {
    const packages = workspacePackages();
    const names = closure(packages);

    step(`pack ${names.length} packages`);
    const tarballs = Path.join(tmp, "tarballs");
    const tarball = new Map<string, string>();
    for (const name of names) {
      const file = Path.join(tarballs, `${name.replace("@", "").replace("/", "-")}.tgz`);
      run("pnpm", ["pack", "--out", file], packages.get(name)!);
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
    // The workspace packages are not on the registry: every reference goes to its tarball.
    const overrides = names
      .filter((name) => name !== CLI)
      .map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${tarball.get(name)}`)}`);
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
      kernel: { plugins: { id: string; status: string; location?: string }[] };
    };
    const plugins = snapshot.kernel.plugins;
    for (const plugin of plugins) process.stdout.write(`${plugin.status.padEnd(8)} ${plugin.id}\n`);
    const broken = plugins.filter((plugin) => plugin.status !== "active");
    if (broken.length > 0) throw new Error(`plugins not active: ${JSON.stringify(broken)}`);

    step("jhin example.greet --name Ada");
    process.stdout.write(run(bin, ["example.greet", "--name", "Ada", ...at], tmp));

    step("jhin serve --ui");
    const { child, output } = await serve(bin, dir);
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      if (!output.includes(", 0 with problems")) throw new Error("jhin serve reported problems");
      const rpc = /rpc: (\S+)/.exec(output)?.[1];
      const ui = /ui: (\S+)/.exec(output)?.[1];
      if (rpc === undefined || ui === undefined) throw new Error("jhin serve printed no endpoints");

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

    step("ok: the packed CLI runs from node_modules");
  } finally {
    if (keep) process.stdout.write(`kept ${tmp}\n`);
    else Fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
