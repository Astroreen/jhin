// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/device/DeviceToolchain.ts
// and deviceToolVersions.json (the pinned packages, where they go, the staging folder, the
// completion sentinel, the serialized installs and the failure wording), without Effect.
// docs/plans/preview.md, D1206.
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

/** T3's pins (`deviceToolVersions.json` at eb7b35ac). Bump both with T3. */
export const DEVICE_TOOL_VERSIONS = {
  "agent-device": "0.21.25",
  "expo-device-hub": "0.15.3",
} as const;

const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** A staging folder untouched this long is a dead install (another node of the home may run one). */
const STAGING_STALE_AFTER_MS = 60 * 60_000;
const SENTINEL = ".install-complete";
/** How much of a program's stdout and stderr is kept, each. */
const OUTPUT_LIMIT = 1024 * 1024;

export interface ToolSpec {
  readonly name: keyof typeof DEVICE_TOOL_VERSIONS;
  readonly version: string;
  /** The entry point inside the package. */
  readonly entry: readonly string[];
}

export const HUB_SPEC: ToolSpec = {
  name: "expo-device-hub",
  version: DEVICE_TOOL_VERSIONS["expo-device-hub"],
  entry: ["dist", "server", "cli.mjs"],
};

export const AGENT_DEVICE_SPEC: ToolSpec = {
  name: "agent-device",
  version: DEVICE_TOOL_VERSIONS["agent-device"],
  entry: ["bin", "agent-device.mjs"],
};

export interface ToolPaths {
  readonly installDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

/** `<home>/tools/<package>/<version>/node_modules/<package>/<entry>`, as T3 lays them out. */
export function toolPaths(home: string, spec: ToolSpec): ToolPaths {
  const installDir = Path.join(home, "tools", spec.name, spec.version);
  return {
    installDir,
    entryPath: Path.join(installDir, "node_modules", spec.name, ...spec.entry),
    sentinelPath: Path.join(installDir, SENTINEL),
  };
}

/** npm extracts files before it finishes, so an entry file alone does not prove a usable tree. */
function isInstalled(paths: ToolPaths, version: string): boolean {
  try {
    return (
      Fs.existsSync(paths.entryPath) &&
      Fs.readFileSync(paths.sentinelPath, "utf8").trim() === version
    );
  } catch {
    return false;
  }
}

class ToolInstallError extends Error {
  readonly tool: string;
  readonly step: string;
  readonly exitCode: number | undefined;

  constructor(tool: string, step: string, exitCode?: number, options?: { cause?: unknown }) {
    super(
      `Installing ${tool} failed while ${step}${exitCode === undefined ? "" : ` (exit code ${exitCode})`}.`,
      options,
    );
    this.name = "ToolInstallError";
    this.tool = tool;
    this.step = step;
    this.exitCode = exitCode;
  }
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program without a shell; `ENOENT` (no such program) rejects with the spawn error. */
export function runProgram(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stdin?: string;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, [...args], {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // A noisy program keeps only its last output: the callers read a JSON line or an exit code.
    const keep = (chunks: Buffer[], chunk: Buffer) => {
      chunks.push(chunk);
      let size = chunks.reduce((total, each) => total + each.length, 0);
      while (size > OUTPUT_LIMIT && chunks.length > 1) size -= chunks.shift()!.length;
    };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => keep(out, chunk));
    child.stderr.on("data", (chunk: Buffer) => keep(err, chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(options.stdin ?? "");
  });
}

/**
 * What npm and the packages' install scripts see of the node's environment: where to find
 * programs and the home, temp folders, proxies, certificates and npm's own settings, never the
 * node's secrets (API keys, tokens).
 */
export function installEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept =
    /^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|SystemRoot|ComSpec|PATHEXT|LANG|LC_ALL|SHELL|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|npm_config_\w+|NPM_CONFIG_\w+|XDG_\w+)$/;
  return Object.fromEntries(Object.entries(env).filter(([name]) => kept.test(name)));
}

/**
 * What the hub, the agent-device daemon and its CLI see while they run: the install
 * environment plus what the device tools need (the Android SDK's variables, Xcode's, the
 * display and user), still without the node's keys and tokens.
 */
export function toolEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const tools = /^(ANDROID_\w+|DEVELOPER_DIR|DISPLAY|WAYLAND_DISPLAY|USER|LOGNAME|JAVA_HOME)$/;
  return {
    ...installEnvironment(env),
    ...Object.fromEntries(Object.entries(env).filter(([name]) => tools.test(name))),
  };
}

export interface ToolchainOptions {
  readonly home: string;
  /** The npm to run, read for each install; `npm` on PATH by default, then pnpm's `dlx npm`. */
  readonly npm?: () => string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/** T3's `deviceToolInstallMessage`: what the panel says while a tool installs. */
export function installMessage(home: string, label: string, spec: ToolSpec): string {
  const versions = installedVersions(home, spec);
  const previous = versions.at(-1);
  return previous !== undefined && !versions.includes(spec.version)
    ? `Updating ${label} from ${previous} to ${spec.version}…`
    : `Installing ${label} ${spec.version}…`;
}

/** The completed installs of a tool, oldest first. */
export function installedVersions(home: string, spec: ToolSpec): string[] {
  let names: string[];
  try {
    names = Fs.readdirSync(Path.join(home, "tools", spec.name));
  } catch {
    return [];
  }
  return names
    .filter((version) => /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    .filter((version) => isInstalled(toolPaths(home, { ...spec, version }), version))
    .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/**
 * The device hub and agent-device in `<home>/tools`, installed with npm on first use.
 * Installs run one at a time (T3's install lock), each into a staging folder that is renamed
 * into place once npm finished and the sentinel is written.
 */
export function createToolchain(options: ToolchainOptions) {
  let queue: Promise<unknown> = Promise.resolve();
  /** Cut by `cancel`: an install in progress stops. */
  let stopped = new AbortController();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const npmInstall = async (spec: ToolSpec, staging: string) => {
    const args = [
      "install",
      "--prefix",
      staging,
      "--no-fund",
      "--no-audit",
      `${spec.name}@${spec.version}`,
    ];
    const run = (command: string, list: readonly string[]) =>
      runProgram(command, list, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal: stopped.signal,
        env: installEnvironment(options.env ?? process.env),
      });
    const npm = options.npm?.();
    try {
      return await run(npm ?? "npm", args);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || npm !== undefined) {
        throw new ToolInstallError(spec.name, "running npm install", undefined, { cause: error });
      }
      try {
        return await run("pnpm", ["--package=npm@11", "dlx", "npm", ...args]);
      } catch (fallback) {
        throw new ToolInstallError(spec.name, "running npm install", undefined, {
          cause: fallback,
        });
      }
    }
  };

  /** Older versions and dead stagings go once a version is in place (D951's clean-up). */
  const prune = (spec: ToolSpec) => {
    const parent = Path.join(options.home, "tools", spec.name);
    for (const name of Fs.readdirSync(parent)) {
      if (name === spec.version) continue;
      const full = Path.join(parent, name);
      if (name.startsWith(".staging-")) {
        const touched = Fs.statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? 0;
        if (Date.now() - touched < STAGING_STALE_AFTER_MS) continue;
      }
      Fs.rmSync(full, { recursive: true, force: true });
    }
  };

  const install = async (spec: ToolSpec): Promise<ToolPaths> => {
    const paths = toolPaths(options.home, spec);
    if (isInstalled(paths, spec.version)) return paths;
    const parent = Path.dirname(paths.installDir);
    const step = (name: string) => (cause: unknown) => {
      throw new ToolInstallError(spec.name, name, undefined, { cause });
    };
    await Fs.promises
      .rm(paths.installDir, { recursive: true, force: true })
      .catch(step("removing an incomplete install"));
    await Fs.promises
      .mkdir(parent, { recursive: true })
      .catch(step("preparing the install directory"));
    const staging = await Fs.promises
      .mkdtemp(Path.join(parent, ".staging-"))
      .catch(step("preparing the install directory"));
    try {
      const result = await npmInstall(spec, staging);
      if (result.code !== 0) {
        throw new ToolInstallError(spec.name, "running npm install", result.code ?? undefined, {
          cause: result,
        });
      }
      if (!Fs.existsSync(Path.join(staging, "node_modules", spec.name, ...spec.entry))) {
        throw new ToolInstallError(spec.name, "verifying the installed entry point");
      }
      await Fs.promises
        .writeFile(Path.join(staging, SENTINEL), `${spec.version}\n`)
        .catch(step("recording the completed install"));
      try {
        await Fs.promises.rename(staging, paths.installDir);
      } catch (cause) {
        // Another node of this home may have published the same version meanwhile.
        if (!isInstalled(paths, spec.version)) step("publishing the install")(cause);
      }
    } finally {
      await Fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    try {
      prune(spec);
    } catch {
      // A version another node still runs may not go; it goes with a later install.
    }
    return paths;
  };

  return {
    paths: (spec: ToolSpec) => toolPaths(options.home, spec),
    installed: (spec: ToolSpec) => isInstalled(toolPaths(options.home, spec), spec.version),
    /** The tool, installed first when it is not. */
    ensure: (spec: ToolSpec): Promise<ToolPaths> => serialized(() => install(spec)),
    /** Stops an install in progress (the plugin going, the setting turned off). */
    cancel: () => {
      stopped.abort();
      stopped = new AbortController();
    },
  };
}

export type Toolchain = ReturnType<typeof createToolchain>;
