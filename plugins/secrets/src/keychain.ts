/**
 * The OS keychain that holds the store's key (docs/plans/security.md, D1024):
 * macOS `security`, Linux `secret-tool`, Windows DPAPI (D1372). The key goes
 * through standard input and output only, never a command line another
 * process could read.
 */
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

/** Runs `command` with `input` on standard input; resolves its exit code and output. */
export type Runner = (
  command: string,
  args: readonly string[],
  input: string,
) => Promise<{ readonly code: number; readonly stdout: string }>;

/** How long a keychain may take, so a locked one cannot hold up the node's start. */
const KEYCHAIN_TIMEOUT_MS = 15_000;

const runProcess: Runner = (command, args, input) =>
  new Promise((resolve) => {
    let child: ChildProcess.ChildProcess;
    try {
      // Killed past the limit: it then counts as no keychain (the key file is used).
      child = ChildProcess.spawn(command, args, {
        stdio: ["pipe", "pipe", "ignore"],
        timeout: KEYCHAIN_TIMEOUT_MS,
      });
    } catch {
      resolve({ code: -1, stdout: "" });
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    // A missing binary is an error event, not a throw.
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });

export interface Keychain {
  readonly kind: "macos" | "libsecret" | "windows";
  /** The stored key, or `undefined` when there is none. */
  get(): Promise<string | undefined>;
  /** Stores the key; `false` when the keychain refused it. */
  set(key: string): Promise<boolean>;
  /** Drops what a refused `set` may have left behind (the DPAPI blob file). */
  forget?(): void;
}

const SERVICE = "Jhin";

/** A quoted argument of `security -i`'s command line. */
function quoted(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function macosKeychain(account: string, run: Runner): Keychain {
  return {
    kind: "macos",
    async get() {
      // Reading puts nothing secret on the command line: the key is the output.
      const result = await run(
        "security",
        ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
        "",
      );
      const key = result.stdout.trim();
      return result.code === 0 && key.length > 0 ? key : undefined;
    },
    async set(key) {
      // `security -i` reads its commands from standard input.
      const command = `add-generic-password -U -s ${quoted(SERVICE)} -a ${quoted(account)} -w ${quoted(key)}\n`;
      return (await run("security", ["-i"], command)).code === 0;
    },
  };
}

export function libsecretKeychain(account: string, run: Runner): Keychain {
  const attributes = ["service", SERVICE, "account", account];
  return {
    kind: "libsecret",
    async get() {
      const result = await run("secret-tool", ["lookup", ...attributes], "");
      const key = result.stdout.trim();
      return result.code === 0 && key.length > 0 ? key : undefined;
    },
    async set(key) {
      const label = `Jhin secret store (${account})`;
      return (
        (await run("secret-tool", ["store", `--label=${label}`, ...attributes], key)).code === 0
      );
    },
  };
}

// DPAPI through PowerShell, as T3 Code unwraps Chromium's keys (MIT, see
// THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/BrowserImport/ChromiumKeys.ts.
// The scripts hold no secret: the key and the blob are standard input and output.
const DPAPI =
  "Add-Type -AssemblyName System.Security;" +
  "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
  "$out=[Security.Cryptography.ProtectedData]::%s($in,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($out))";
/** Where the DPAPI-wrapped key is kept, beside the store (D1372). */
export const DPAPI_KEY_FILE = "store.key.dpapi";
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

/**
 * The key wrapped with DPAPI for the current Windows user, the blob kept in
 * `file` (0600) beside the store (D1372): only that user on that machine
 * unwraps it.
 */
export function windowsKeychain(file: string, run: Runner): Keychain {
  const utf8 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  return {
    kind: "windows",
    forget() {
      Fs.rmSync(file, { force: true });
    },
    async get() {
      let blob: string;
      try {
        blob = Fs.readFileSync(file, "utf8").trim();
      } catch {
        return undefined;
      }
      const result = await run(
        "powershell.exe",
        [...POWERSHELL_ARGS, DPAPI.replace("%s", "Unprotect")],
        blob,
      );
      if (result.code !== 0 || result.stdout.trim() === "") return undefined;
      const key = Buffer.from(result.stdout.trim(), "base64").toString("utf8").trim();
      return key.length > 0 ? key : undefined;
    },
    async set(key) {
      const result = await run(
        "powershell.exe",
        [...POWERSHELL_ARGS, DPAPI.replace("%s", "Protect")],
        utf8(key),
      );
      const blob = result.stdout.trim();
      if (result.code !== 0 || blob === "") return false;
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        Fs.writeFileSync(temporary, `${blob}\n`, { mode: 0o600 });
        Fs.renameSync(temporary, file);
        return true;
      } catch {
        Fs.rmSync(temporary, { force: true });
        return false;
      }
    },
  };
}

/** Whether `name` is an executable file in one of `PATH`'s directories. */
function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env["PATH"] ?? "")
    .split(Path.delimiter)
    .filter((dir) => dir !== "")
    .some((dir) => {
      try {
        Fs.accessSync(Path.join(dir, name), Fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * The keychain this machine may have, or `undefined`: macOS always has one;
 * Linux when `secret-tool` is installed and a D-Bus session bus is set;
 * Windows DPAPI with its blob in `dpapiFile` (D1372), when one is given.
 * Whether it works shows when the store's key is first put into it.
 */
export function findKeychain(
  account: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: Runner;
    readonly dpapiFile?: string;
  } = {},
): Keychain | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runProcess;
  if (platform === "darwin") return macosKeychain(account, run);
  if (platform === "win32" && options.dpapiFile !== undefined) {
    return windowsKeychain(options.dpapiFile, run);
  }
  if (
    platform === "linux" &&
    (env["DBUS_SESSION_BUS_ADDRESS"] ?? "") !== "" &&
    onPath("secret-tool", env)
  ) {
    return libsecretKeychain(account, run);
  }
  return undefined;
}
