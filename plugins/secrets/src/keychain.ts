/**
 * The OS keychain that holds the store's key (docs/plans/security.md, D1024):
 * macOS `security`, Linux `secret-tool`. The key goes through standard input
 * and output only, never a command line another process could read.
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

const runProcess: Runner = (command, args, input) =>
  new Promise((resolve) => {
    let child: ChildProcess.ChildProcess;
    try {
      child = ChildProcess.spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
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
  readonly kind: "macos" | "libsecret";
  /** The stored key, or `undefined` when there is none. */
  get(): Promise<string | undefined>;
  /** Stores the key; `false` when the keychain refused it. */
  set(key: string): Promise<boolean>;
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
 * Linux when `secret-tool` is installed and a D-Bus session bus is set.
 * Windows uses the key file (docs/plans/security.md, Deferred). Whether it
 * works shows when the store's key is first put into it.
 */
export function findKeychain(
  account: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: Runner;
  } = {},
): Keychain | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runProcess;
  if (platform === "darwin") return macosKeychain(account, run);
  if (
    platform === "linux" &&
    (env["DBUS_SESSION_BUS_ADDRESS"] ?? "") !== "" &&
    onPath("secret-tool", env)
  ) {
    return libsecretKeychain(account, run);
  }
  return undefined;
}
