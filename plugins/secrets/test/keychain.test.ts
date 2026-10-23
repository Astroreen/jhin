import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { openStore } from "../src/store.ts";
import {
  findKeychain,
  libsecretKeychain,
  macosKeychain,
  windowsKeychain,
  type Runner,
} from "../src/keychain.ts";

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
    expect(
      findKeychain("a", { platform: "win32", env: {}, run, dpapiFile: "C:/x/store.key.dpapi" })
        ?.kind,
    ).toBe("windows");
  });
});

describe("the Windows keychain (security.md D1372)", () => {
  /**
   * A fake PowerShell: "protects" by reversing the base64 text it reads and
   * marking it, as DPAPI would give an opaque blob; records every call.
   */
  function fakePowerShell() {
    const calls: { command: string; args: readonly string[]; input: string }[] = [];
    const run: Runner = async (command, args, input) => {
      calls.push({ command, args, input });
      const script = args.at(-1) ?? "";
      if (script.includes("::Protect(")) {
        return { code: 0, stdout: `dpapi:${input.trim().split("").toReversed().join("")}` };
      }
      if (script.includes("::Unprotect(") && input.trim().startsWith("dpapi:")) {
        return { code: 0, stdout: input.trim().slice(6).split("").toReversed().join("") };
      }
      return { code: 1, stdout: "" };
    };
    return { calls, run };
  }

  it("wraps the key with DPAPI through standard input and keeps only the blob, 0600", async () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-dpapi-"));
    const file = Path.join(dir, "store.key.dpapi");
    const { calls, run } = fakePowerShell();
    const keychain = windowsKeychain(file, run);
    expect(await keychain.get()).toBeUndefined();
    expect(await keychain.set(KEY)).toBe(true);
    expect(await keychain.get()).toBe(KEY);
    const blob = Fs.readFileSync(file, "utf8");
    expect(blob).not.toContain(KEY);
    expect(blob).toMatch(/^dpapi:/);
    // Modes are POSIX's; on Windows the user's profile directory guards it.
    if (process.platform !== "win32") expect(Fs.statSync(file).mode & 0o777).toBe(0o600);
    for (const call of calls) {
      expect(call.command).toBe("powershell.exe");
      expect(call.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
      expect(call.args.join(" ")).not.toContain(KEY);
      expect(call.args.join(" ")).toContain("DataProtectionScope]::CurrentUser");
      // The script T3 runs to unwrap Chromium's keys, with Protect for wrapping.
      expect(call.args.at(-1)).toMatch(
        /^Add-Type -AssemblyName System\.Security;\$in=\[Convert\]::FromBase64String\(\[Console\]::In\.ReadToEnd\(\)\.Trim\(\)\);\$out=\[Security\.Cryptography\.ProtectedData\]::(Protect|Unprotect)\(\$in,\$null,\[Security\.Cryptography\.DataProtectionScope\]::CurrentUser\);\[Console\]::Out\.Write\(\[Convert\]::ToBase64String\(\$out\)\)$/,
      );
    }
    // The key went in as base64 of its text, on standard input.
    expect(calls[0]?.input).toBe(Buffer.from(KEY).toString("base64"));
  });

  it("keeps a new store's key with DPAPI and opens it again; refuses a blob it cannot unwrap", async () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-dpapi-"));
    const { run } = fakePowerShell();
    const keychain = findKeychain("jhin.secrets:node-1", {
      platform: "win32",
      env: {},
      run,
      dpapiFile: Path.join(dir, "store.key.dpapi"),
    });
    const store = await openStore({ dir, keychain });
    const place = { section: "acme.vault", path: ["token"] };
    const reference = store.putConfig("sk-windows", place);
    expect(store.status()).toMatchObject({ key: "keychain", keychain: "windows" });
    expect(Fs.existsSync(Path.join(dir, "store.key"))).toBe(false);
    expect((await openStore({ dir, keychain })).resolveConfig(reference, place)).toBe("sk-windows");
    // Another user's DPAPI (here: a PowerShell that unwraps nothing) cannot open it.
    const stranger = windowsKeychain(Path.join(dir, "store.key.dpapi"), async () => ({
      code: 1,
      stdout: "",
    }));
    expect((await openStore({ dir, keychain: stranger })).readable).toBe(false);
    // A keychain that does not keep a new store's key is said, not hidden.
    const refused: string[] = [];
    const fresh = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-dpapi-"));
    await openStore({
      dir: fresh,
      keychain: stranger,
      onKeychainRefused: (kind) => refused.push(kind),
    });
    expect(refused).toEqual(["windows"]);
    expect(Fs.existsSync(Path.join(fresh, "store.key"))).toBe(true);
    // A blob written by a set whose key did not read back is gone.
    const half = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-dpapi-"));
    const writesOnly = windowsKeychain(
      Path.join(half, "store.key.dpapi"),
      async (_c, args, input) =>
        (args.at(-1) ?? "").includes("::Protect(")
          ? { code: 0, stdout: `dpapi:${input}` }
          : { code: 1, stdout: "" },
    );
    await openStore({ dir: half, keychain: writesOnly });
    expect(Fs.existsSync(Path.join(half, "store.key.dpapi"))).toBe(false);
    expect(Fs.existsSync(Path.join(half, "store.key"))).toBe(true);
  });
});
