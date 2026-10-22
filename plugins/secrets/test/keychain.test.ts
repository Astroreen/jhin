import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { findKeychain, libsecretKeychain, macosKeychain, type Runner } from "../src/keychain.ts";

const KEY = "c2VjcmV0LWtleS1vZi10aGUtc3RvcmUtMzItYnl0ZXM=";

/** Records every call; answers `lookup`/`find` with what was stored. */
function recordingRunner() {
  const calls: { command: string; args: readonly string[]; input: string }[] = [];
  let stored: string | undefined;
  const run: Runner = async (command, args, input) => {
    calls.push({ command, args, input });
    if (args.includes("store")) stored = input;
    if (args[0] === "-i") stored = /-w "([^"]*)"/.exec(input)?.[1];
    if (args.includes("lookup") || args.includes("find-generic-password")) {
      return { code: stored === undefined ? 1 : 0, stdout: stored ?? "" };
    }
    return { code: 0, stdout: "" };
  };
  return { calls, run };
}

describe("the keychain (security.md D1024)", () => {
  it("passes the key to secret-tool on standard input, never as an argument", async () => {
    const { calls, run } = recordingRunner();
    const keychain = libsecretKeychain("jhin.secrets:node-1", run);
    expect(await keychain.set(KEY)).toBe(true);
    expect(await keychain.get()).toBe(KEY);
    expect(calls.every((call) => !call.args.join(" ").includes(KEY))).toBe(true);
    expect(calls[0]).toMatchObject({
      command: "secret-tool",
      args: [
        "store",
        "--label=Jhin secret store (jhin.secrets:node-1)",
        "service",
        "Jhin",
        "account",
        "jhin.secrets:node-1",
      ],
      input: KEY,
    });
  });

  it("passes the key to macOS security through its interactive mode", async () => {
    const { calls, run } = recordingRunner();
    const keychain = macosKeychain("jhin.secrets:node-1", run);
    expect(await keychain.set(KEY)).toBe(true);
    expect(await keychain.get()).toBe(KEY);
    expect(calls.every((call) => !call.args.join(" ").includes(KEY))).toBe(true);
    expect(calls[0]?.args).toEqual(["-i"]);
  });

  it("finds a keychain on macOS, on Linux with secret-tool and a session bus, and nowhere else", () => {
    const bin = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-bin-"));
    Fs.writeFileSync(Path.join(bin, "secret-tool"), "#!/bin/sh\n", { mode: 0o755 });
    const run: Runner = async () => ({ code: 0, stdout: "" });
    expect(findKeychain("a", { platform: "darwin", env: {}, run })?.kind).toBe("macos");
    expect(
      findKeychain("a", {
        platform: "linux",
        env: { PATH: bin, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
        run,
      })?.kind,
    ).toBe("libsecret");
    expect(findKeychain("a", { platform: "linux", env: { PATH: bin }, run })).toBeUndefined();
    expect(
      findKeychain("a", {
        platform: "linux",
        env: { PATH: "/nonexistent", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
        run,
      }),
    ).toBeUndefined();
    expect(findKeychain("a", { platform: "win32", env: {}, run })).toBeUndefined();
  });
});
