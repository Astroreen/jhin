import { describe, expect, it } from "vite-plus/test";

import {
  bundledClaude,
  claudeExecutable,
  claudeOnPath,
  type ExecutableHost,
} from "../src/executable.ts";

/** A machine with these files, and these modules installed beside the SDK. */
const host = (
  files: readonly string[],
  modules: Record<string, string>,
  overrides: Partial<ExecutableHost> = {},
): ExecutableHost => ({
  platform: "linux",
  arch: "x64",
  env: { PATH: "/usr/local/bin:/home/me/.local/bin" },
  resolve: (specifier) => {
    const path = modules[specifier];
    if (path === undefined) throw new Error(`Cannot find module '${specifier}'`);
    return path;
  },
  isFile: (path) => files.includes(path),
  ...overrides,
});

const BUNDLED = "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";

describe("the Claude Code executable (desktop.md D1694)", () => {
  it("runs the configured one, else the SDK's own, else `claude` on the PATH", () => {
    const bundled = host([BUNDLED, "/home/me/.local/bin/claude"], {
      "@anthropic-ai/claude-agent-sdk-linux-x64/claude": BUNDLED,
    });
    expect(claudeExecutable("/opt/claude", bundled)).toBe("/opt/claude");
    // The SDK finds its own binary: nothing to pass.
    expect(claudeExecutable(undefined, bundled)).toBeUndefined();
    expect(bundledClaude(bundled)).toBe(BUNDLED);

    const trimmed = host(["/home/me/.local/bin/claude"], {});
    expect(claudeExecutable(undefined, trimmed)).toBe("/home/me/.local/bin/claude");
    // Neither: the SDK says it found none.
    expect(claudeExecutable(undefined, host([], {}))).toBeUndefined();
  });

  it("takes the musl package on Linux, and only Windows' `.exe` on its PATH", () => {
    const musl = "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude";
    expect(
      bundledClaude(host([musl], { "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude": musl })),
    ).toBe(musl);
    // Windows: the `.exe` only; the SDK cannot spawn an npm `.cmd` shim without a shell.
    const windowsHost = (files: readonly string[]) =>
      host(files, {}, { platform: "win32", env: { Path: "C:\\Windows;C:\\Users\\me\\bin" } });
    expect(claudeOnPath(windowsHost(["C:\\Users\\me\\bin\\claude.cmd"]))).toBeUndefined();
    expect(claudeOnPath(windowsHost(["C:\\Users\\me\\bin\\claude.exe"]))).toBe(
      "C:\\Users\\me\\bin\\claude.exe",
    );
  });
});
