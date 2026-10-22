// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/ChromiumKeys.ts and native/browser-secret/main.c
// (its exit codes). docs/plans/preview.md, D1204.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";

import { isAborted, type ImportHost } from "./host.ts";

const KEY_SALT = "saltysalt";
const KEY_LENGTH = 16;
/** macOS stretches the keychain secret; Linux uses a single iteration. */
const MAC_KEY_ITERATIONS = 1003;
const LINUX_KEY_ITERATIONS = 1;
/** Chromium's documented fallback passphrase when no Linux keyring is present. */
const LINUX_FALLBACK_PASSPHRASE = "peanuts";
/**
 * How long a Keychain or keyring prompt may stay unanswered. T3 waits for the
 * user without limit, who sits at its window; a node may be headless or
 * unattended, where nobody ever answers and `preview.import.cookies` would never
 * return. Long enough for a person to find and answer the prompt.
 */
const KEY_PROMPT_TIMEOUT_MS = 5 * 60_000;

const promptSignal = () => AbortSignal.timeout(KEY_PROMPT_TIMEOUT_MS);

/** `security`'s exit status for "The specified item could not be found in the keychain." */
const SECURITY_ITEM_NOT_FOUND = 44;

export type ChromiumKeyFailure =
  | "needsKeychainApproval"
  | "keychainItemMissing"
  | "keychainUnavailable"
  | "unsupportedPlatform"
  | "readFailed";

export class ChromiumKeyError extends Error {
  readonly reason: ChromiumKeyFailure;

  constructor(reason: ChromiumKeyFailure, options?: { cause?: unknown }) {
    super(`Could not obtain the Chromium cookie key: ${reason}.`, options);
    this.name = "ChromiumKeyError";
    this.reason = reason;
  }
}

export interface ChromiumKeyMaterial {
  readonly cbcV10?: Buffer;
  readonly cbcV11?: Buffer;
  readonly cbcV11Error?: ChromiumKeyError;
  /**
   * AES-128-CBC from an empty passphrase. Some Linux clients wrote records with
   * it (crbug.com/1195256), so Chromium, and this import, retry with it after a
   * record's own key fails.
   */
  readonly cbcEmpty?: Buffer;
  readonly gcmV10?: Buffer;
}

const deriveChromiumKey = (passphrase: string, iterations: number): Buffer =>
  Crypto.pbkdf2Sync(passphrase, KEY_SALT, iterations, KEY_LENGTH, "sha1");

/**
 * The browser's "Safe Storage" secret from the login keychain, with macOS's own
 * `security` tool (T3 asks in-process through a keyring binding; the node has
 * none, so the prompt names `security`). Bounded by `KEY_PROMPT_TIMEOUT_MS`: a
 * prompt nobody answered is `needsKeychainApproval`, as a denied one.
 */
async function readKeychainSecret(
  host: ImportHost,
  service: string,
  account: string,
): Promise<string> {
  let result;
  try {
    result = await host.run(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service, "-a", account],
      { signal: promptSignal() },
    );
  } catch (cause) {
    throw new ChromiumKeyError(isAborted(cause) ? "needsKeychainApproval" : "keychainUnavailable", {
      cause,
    });
  }
  if (result.exitCode === SECURITY_ITEM_NOT_FOUND)
    throw new ChromiumKeyError("keychainItemMissing");
  if (result.exitCode !== 0) throw new ChromiumKeyError("needsKeychainApproval");
  // `-w` prints the password and one newline.
  const secret = result.stdout.toString("utf8").replace(/\n$/, "");
  if (secret === "") throw new ChromiumKeyError("keychainItemMissing");
  return secret;
}

/**
 * The browser's libsecret key (`application` attribute, matched without the
 * schema name, as Chromium and T3's helper do) through `secret-tool`, which
 * keeps the desktop's unlock prompt. Its output is the bare secret on a pipe;
 * it is not trimmed, since whitespace would change the derived key. A missing
 * item exits 1 with nothing on stderr; a locked or refused keyring says so.
 */
export async function readLinuxSecret(host: ImportHost, application: string): Promise<string> {
  let result;
  try {
    result = await host.run("secret-tool", ["lookup", "application", application], {
      signal: promptSignal(),
    });
  } catch (cause) {
    // An unlock prompt nobody answered is a consent failure, as a cancelled one.
    throw new ChromiumKeyError(isAborted(cause) ? "needsKeychainApproval" : "keychainUnavailable", {
      cause,
    });
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (stderr === "") throw new ChromiumKeyError("keychainItemMissing");
    if (/locked|cancel|dismiss|denied|not allowed/i.test(stderr)) {
      throw new ChromiumKeyError("needsKeychainApproval", { cause: new Error(stderr) });
    }
    throw new ChromiumKeyError("keychainUnavailable", { cause: new Error(stderr) });
  }
  const secret = result.stdout.toString("utf8");
  if (secret === "") throw new ChromiumKeyError("keychainItemMissing");
  return secret;
}

const DPAPI_PREFIX = Buffer.from("DPAPI");
const WINDOWS_KEY_LENGTH = 32;
const WINDOWS_DPAPI_SCRIPT =
  "Add-Type -AssemblyName System.Security;" +
  "$value=[Console]::In.ReadToEnd();" +
  "$encrypted=[Convert]::FromBase64String($value);" +
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($plain))";

/** The DPAPI-wrapped key of `Local State`; an app-bound key cannot be read by anyone else. */
export function decodeWindowsWrappedKey(contents: string): Buffer {
  let state: unknown;
  try {
    state = JSON.parse(contents);
  } catch (cause) {
    throw new ChromiumKeyError("readFailed", { cause });
  }
  const crypt = (state as { os_crypt?: unknown } | null)?.os_crypt as
    | { encrypted_key?: unknown; app_bound_encrypted_key?: unknown }
    | undefined;
  if (typeof crypt?.encrypted_key !== "string") throw new ChromiumKeyError("readFailed");
  if (crypt.app_bound_encrypted_key !== undefined) {
    throw new ChromiumKeyError("unsupportedPlatform");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(crypt.encrypted_key)) throw new ChromiumKeyError("readFailed");
  const wrapped = Buffer.from(crypt.encrypted_key, "base64");
  if (!wrapped.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) {
    throw new ChromiumKeyError("readFailed");
  }
  return wrapped.subarray(DPAPI_PREFIX.length);
}

export async function unwrapWindowsDpapiKey(host: ImportHost, wrapped: Buffer): Promise<Buffer> {
  const windowsRoot = host.env.SystemRoot ?? host.env.WINDIR;
  const powershell = windowsRoot
    ? `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  let result;
  try {
    result = await host.run(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        WINDOWS_DPAPI_SCRIPT,
      ],
      { stdin: wrapped.toString("base64"), signal: promptSignal() },
    );
  } catch (cause) {
    throw new ChromiumKeyError(isAborted(cause) ? "readFailed" : "keychainUnavailable", { cause });
  }
  if (result.exitCode !== 0) throw new ChromiumKeyError("readFailed");
  const plain = Buffer.from(result.stdout.toString("utf8").trim(), "base64");
  if (plain.length !== WINDOWS_KEY_LENGTH) throw new ChromiumKeyError("readFailed");
  return plain;
}

export async function readWindowsKey(host: ImportHost, localStatePath: string): Promise<Buffer> {
  let contents: string;
  try {
    contents = await Fs.promises.readFile(localStatePath, "utf8");
  } catch (cause) {
    throw new ChromiumKeyError("readFailed", { cause });
  }
  return unwrapWindowsDpapiKey(host, decodeWindowsWrappedKey(contents));
}

export interface ChromiumKeyRequest {
  readonly platform: NodeJS.Platform;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly linuxSecretApplication: string | undefined;
}

export async function resolveChromiumKeys(
  host: ImportHost,
  request: ChromiumKeyRequest,
): Promise<ChromiumKeyMaterial> {
  if (request.platform === "darwin") {
    if (!request.keychainService || !request.keychainAccount) {
      throw new ChromiumKeyError("unsupportedPlatform");
    }
    const secret = await readKeychainSecret(host, request.keychainService, request.keychainAccount);
    return { cbcV10: deriveChromiumKey(secret, MAC_KEY_ITERATIONS) };
  }

  if (request.platform === "linux") {
    // The fallback passphrase always applies to `v10` records; a keyring secret,
    // when one is reachable, additionally unlocks `v11`.
    let keyring: string | ChromiumKeyError | undefined;
    if (request.linuxSecretApplication) {
      try {
        keyring = await readLinuxSecret(host, request.linuxSecretApplication);
      } catch (error) {
        // v10 stays importable when Secret Service is absent or holds no key; an
        // explicit denial, lock or cancel stays a consent failure.
        if (!(error instanceof ChromiumKeyError) || error.reason === "needsKeychainApproval") {
          throw error;
        }
        keyring = error;
      }
    }
    return {
      cbcV10: deriveChromiumKey(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS),
      ...(typeof keyring === "string"
        ? { cbcV11: deriveChromiumKey(keyring, LINUX_KEY_ITERATIONS) }
        : keyring
          ? { cbcV11Error: keyring }
          : {}),
      cbcEmpty: deriveChromiumKey("", LINUX_KEY_ITERATIONS),
    };
  }

  throw new ChromiumKeyError("unsupportedPlatform");
}
