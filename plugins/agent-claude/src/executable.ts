// Mirrors the Claude Agent SDK's own lookup of its native binary (its `K4`: the platform
// package `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude[.exe]`), and T3's
// default `binaryPath` setting, `claude` (MIT, see THIRD_PARTY_NOTICES.md:
// packages/contracts/src/settings.ts). docs/plans/desktop.md, D1694.
import * as Fs from "node:fs";
import { createRequire } from "node:module";
import * as Path from "node:path";

/** What finding an executable reads, injected so the lookup is tested without the machine's. */
export interface ExecutableHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  /** Resolves a module path as the SDK does, from the SDK itself; throws when not installed. */
  resolve(specifier: string): string;
  isFile(path: string): boolean;
}

const sdkRequire = () => createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));

export const nodeExecutableHost: ExecutableHost = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  resolve: (specifier) => sdkRequire().resolve(specifier),
  isFile: (path) => {
    try {
      return Fs.statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

/** The SDK's own binary for this system, when its platform package is installed. */
export function bundledClaude(host: ExecutableHost): string | undefined {
  const base = `@anthropic-ai/claude-agent-sdk-${host.platform}-${host.arch}`;
  const suffix = host.platform === "win32" ? ".exe" : "";
  const packages = host.platform === "linux" ? [base, `${base}-musl`] : [base];
  for (const name of packages) {
    try {
      const path = host.resolve(`${name}/claude${suffix}`);
      if (host.isFile(path)) return path;
    } catch {
      // Not installed: the next candidate.
    }
  }
  return undefined;
}

/**
 * `claude` on the PATH. On Windows only `claude.exe`: the SDK spawns its executable without a
 * shell, so an npm `claude.cmd` shim would not start (set `binaryPath` to the `.exe` then).
 */
export function claudeOnPath(host: ExecutableHost): string | undefined {
  const windows = host.platform === "win32";
  const path = host.env["PATH"] ?? host.env["Path"] ?? "";
  for (const dir of path.split(windows ? ";" : ":")) {
    if (dir === "") continue;
    const candidate = (windows ? Path.win32 : Path.posix).join(
      dir,
      windows ? "claude.exe" : "claude",
    );
    if (host.isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The executable a turn runs (D1694): the configured one; else the SDK's own binary when it is
 * installed (the CLI's npm install); else `claude` on the PATH, T3's default, for an install
 * without it (the desktop app leaves the binary out). Undefined lets the SDK say it found none.
 */
export function claudeExecutable(
  binaryPath: string | undefined,
  host: ExecutableHost = nodeExecutableHost,
): string | undefined {
  if (binaryPath !== undefined) return binaryPath;
  if (bundledClaude(host) !== undefined) return undefined;
  return claudeOnPath(host);
}
