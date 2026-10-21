// Packages the desktop app with electron-builder (docs/plans/desktop.md, D942–D944).
//
//   node scripts/package-desktop.ts [--platform linux|mac|win] [--arch x64|arm64]
//                                   [--version 1.2.3] [--repository owner/repo] [--dir]
//                                   [--require-signing]
//
// Builds the app's main process and preload, packs `jhin-ai` and
// `@jhin/plugin-desktop` with every workspace package they need (scripts/pack.ts,
// as scripts/pack-smoke.ts does), installs the tarballs into a staged app outside
// the workspace with the third-party versions of pnpm-lock.yaml, and runs
// electron-builder on it. Installers and the feed files (`latest*.yml` or
// `nightly*.yml`) land in apps/desktop/release/.
//
// `--repository` gives the build its update feed (the release workflow passes
// this repository); without it the app has none and shows updates as disabled.
// `--dir` builds the unpacked app only, for a local check. The build signs only
// when every secret of the platform is set (scripts/desktop-release.ts,
// SIGNING_SECRETS); none set builds unsigned (an error with --require-signing),
// some set is an error. It packages for the machine it runs on only.

import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { parseArgs } from "node:util";

import {
  builderConfig,
  catalogVersion,
  packageOptions,
  signing,
  SIGNING_SECRETS,
} from "./desktop-release.ts";
import { lockedPins } from "./packing.ts";
import { closure, type Manifest, readJson, ROOT, workspacePackages } from "./workspace-packages.ts";

const DESKTOP = Path.join(ROOT, "apps", "desktop");
const ROOTS = ["jhin-ai", "@jhin/plugin-desktop"];
const windows = process.platform === "win32";

function step(text: string): void {
  process.stdout.write(`\n== ${text}\n`);
}

/** Quotes an argument for cmd.exe; Jhin's paths and arguments hold no `"` or `%`. */
function quote(arg: string): string {
  if (/["%]/.test(arg)) throw new Error(`Cannot pass ${arg} through cmd.exe`);
  return /[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg;
}

/** Runs a command; only electron-builder is given the signing secrets. */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env = withoutSecrets(process.env),
): void {
  // pnpm and electron-builder are .cmd shims on Windows, which only cmd.exe runs;
  // the line is quoted here rather than joined unquoted by `shell: true`.
  const result = windows
    ? ChildProcess.spawnSync(
        process.env["ComSpec"] ?? "cmd.exe",
        ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`],
        { cwd, env, stdio: "inherit", windowsVerbatimArguments: true },
      )
    : ChildProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

const catalog = (name: string) =>
  catalogVersion(Fs.readFileSync(Path.join(ROOT, "pnpm-workspace.yaml"), "utf8"), name);

/** The environment without signing secrets: installing runs third-party scripts (D944). */
function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secrets = new Set([...SIGNING_SECRETS.mac, ...SIGNING_SECRETS.win]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !secrets.has(name)));
}

function main(): void {
  const { values } = parseArgs({
    options: {
      platform: { type: "string" },
      arch: { type: "string" },
      version: { type: "string" },
      repository: { type: "string" },
      dir: { type: "boolean", default: false },
      "require-signing": { type: "boolean", default: false },
    },
  });
  const { platform, arch } = packageOptions(values, process);
  const desktop = readJson<Manifest & { description: string }>(Path.join(DESKTOP, "package.json"));
  const version = values.version ?? desktop.version!;

  const sign = signing(platform, process.env);
  if (sign.missing.length > 0) {
    throw new Error(`${platform} signing is half configured; missing: ${sign.missing.join(", ")}`);
  }
  // A stable release must not ship unsigned because its secrets went missing (D944).
  if (values["require-signing"] && SIGNING_SECRETS[platform].length > 0 && !sign.signed) {
    throw new Error(
      `${platform} signing is required but not configured; set ${SIGNING_SECRETS[platform].join(", ")}`,
    );
  }
  process.stdout.write(
    `${platform} ${arch} ${version}, ${sign.signed ? "signed" : "unsigned"}, ` +
      `${values.repository === undefined ? "no update feed" : `feed ${values.repository}`}\n`,
  );

  step("build the main process and the preload");
  run("pnpm", ["--filter", "@jhin/desktop", "run", "build"], ROOT);

  const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-desktop-"));
  try {
    const packages = workspacePackages();
    const names = closure(packages, ROOTS);
    step(`pack ${names.length} packages`);
    const tarball = new Map<string, string>();
    for (const name of names) {
      const file = Path.join(tmp, "tarballs", `${name.replace("@", "").replace("/", "-")}.tgz`);
      run("node", [Path.join(ROOT, "scripts", "pack.ts"), packages.get(name)!, file], ROOT);
      tarball.set(name, file);
    }

    const app = Path.join(tmp, "app");
    step(`stage the app in ${app}`);
    Fs.mkdirSync(app);
    Fs.cpSync(Path.join(DESKTOP, "dist"), Path.join(app, "dist"), { recursive: true });
    const root = readJson<Manifest>(Path.join(ROOT, "package.json"));
    Fs.writeFileSync(
      Path.join(app, "package.json"),
      JSON.stringify(
        {
          name: "jhin-desktop",
          productName: "Jhin",
          version,
          description: desktop.description,
          author: "Jhin <noreply@github.com>",
          homepage: "https://github.com/Astroreen/jhin",
          license: "Apache-2.0",
          type: "module",
          main: "dist/main.js",
          packageManager: root.packageManager,
          dependencies: {
            ...Object.fromEntries(ROOTS.map((name) => [name, `file:${tarball.get(name)}`])),
            "electron-updater": catalog("electron-updater"),
          },
        },
        null,
        2,
      ),
    );
    // Workspace packages come from their tarballs, third-party ones at the
    // versions of the workspace lockfile (as scripts/pack-smoke.ts installs them).
    const locked = lockedPins(Fs.readFileSync(Path.join(ROOT, "pnpm-lock.yaml"), "utf8"));
    const pins = new Map<string, string>([
      ...locked.pins,
      ...names.map((name): [string, string] => [name, `file:${tarball.get(name)}`]),
    ]);
    const overrides = [...pins].map(
      ([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`,
    );
    // A flat node_modules, which electron-builder copies as it is.
    Fs.writeFileSync(
      Path.join(app, "pnpm-workspace.yaml"),
      `nodeLinker: hoisted\noverrides:\n${overrides.join("\n")}\nallowBuilds:\n  node-pty: true\n`,
    );
    run("pnpm", ["install", "--prod"], app);

    step("electron-builder");
    const config = builderConfig({
      platform,
      version,
      electronVersion: catalog("electron"),
      repository: values.repository,
      signed: sign.signed,
      env: process.env,
    });
    // Output and resources stay in the workspace; the staged app is thrown away.
    config["directories"] = {
      output: Path.join(DESKTOP, "release"),
      buildResources: Path.join(DESKTOP, "resources"),
    };
    const configFile = Path.join(tmp, "electron-builder.json");
    Fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    const builder = Path.join(
      ROOT,
      "node_modules",
      ".bin",
      windows ? "electron-builder.cmd" : "electron-builder",
    );
    run(
      builder,
      [
        "--projectDir",
        app,
        "--config",
        configFile,
        `--${platform}`,
        `--${arch}`,
        "--publish",
        "never",
        ...(values.dir ? ["--dir"] : []),
      ],
      ROOT,
      // An unsigned build must not pick a certificate out of the keychain.
      sign.signed
        ? process.env
        : { ...withoutSecrets(process.env), CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    );
    step(`done: ${Path.join(DESKTOP, "release")}`);
  } finally {
    Fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
