/**
 * The secret store's file (docs/plans/security.md, D1023): every entry in one
 * JSON document sealed with AES-256-GCM, its key in the OS keychain (D1024)
 * or in a key file beside it. Written whole and renamed into place, 0600.
 */
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  CONFIG_SECRET_PATTERN,
  SECRET_REF_PATTERN,
  SECRET_REF_TTL_MS,
  SecretsError,
  configSecretPlace,
  type ConfigSecretPlace,
  type SecretStore,
  type SecretsStatus,
} from "@jhin/secrets-api";

import type { Keychain } from "./keychain.ts";

const STORE_FILE = "store.json";
const KEY_FILE = "store.key";

interface ConfigEntry {
  /** `configSecretPlace` of where it belongs (D1025). */
  readonly place: string;
  readonly value: string;
  readonly savedAt: number;
}

interface RefEntry {
  readonly projectId: string;
  readonly threadId: string;
  readonly value: string;
  readonly savedAt: number;
}

interface NamedEntry {
  readonly value: string;
  readonly savedAt: number;
}

interface Entries {
  config: Record<string, ConfigEntry>;
  refs: Record<string, RefEntry>;
  /** The node's own random secrets by name (D1192). */
  named: Record<string, NamedEntry>;
}

interface Sealed {
  readonly version: 1;
  readonly key: "keychain" | "file";
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export interface OpenedStore extends SecretStore {
  getOrCreateRandom(name: string, bytes: number): string;
  status(): SecretsStatus;
  /** Removes the refs older than their time to live (D1030); how many went. */
  sweep(): number;
}

function seal(entries: Entries, key: Buffer, where: Sealed["key"]): Sealed {
  const iv = Crypto.randomBytes(12);
  const cipher = Crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
  return {
    version: 1,
    key: where,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function unseal(sealed: Sealed, key: Buffer): Entries {
  const decipher = Crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const text = Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(text) as Partial<Entries>;
  return { config: parsed.config ?? {}, refs: parsed.refs ?? {}, named: parsed.named ?? {} };
}

/** Written to a temporary file, flushed to disk, then renamed over `file`. */
function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = Fs.openSync(temporary, "w", 0o600);
    try {
      Fs.writeFileSync(fd, text);
      Fs.fsyncSync(fd);
    } finally {
      Fs.closeSync(fd);
    }
    Fs.chmodSync(temporary, 0o600);
    Fs.renameSync(temporary, file);
  } catch (error) {
    Fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readSealed(file: string): Sealed | undefined {
  try {
    const parsed = JSON.parse(Fs.readFileSync(file, "utf8")) as Partial<Sealed>;
    if (
      parsed.version !== 1 ||
      (parsed.key !== "keychain" && parsed.key !== "file") ||
      typeof parsed.iv !== "string" ||
      typeof parsed.tag !== "string" ||
      typeof parsed.data !== "string"
    ) {
      return undefined;
    }
    return parsed as Sealed;
  } catch {
    return undefined;
  }
}

function decodeKey(text: string | undefined): Buffer | undefined {
  if (text === undefined) return undefined;
  const key = Buffer.from(text.trim(), "base64");
  return key.length === 32 ? key : undefined;
}

/**
 * Opens the store in `dir`, or makes one: a new key goes to `keychain` when it
 * keeps it (put, then read back), else to the key file. An existing store
 * keeps its key where it says. One that cannot be opened stays untouched and
 * is reported unreadable.
 */
export async function openStore(options: {
  readonly dir: string;
  readonly keychain: Keychain | undefined;
  readonly now?: () => number;
  /** A new store's keychain did not keep its key: the key file is used instead. */
  readonly onKeychainRefused?: (kind: Keychain["kind"]) => void;
}): Promise<OpenedStore> {
  const now = options.now ?? Date.now;
  Fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  Fs.chmodSync(options.dir, 0o700);
  const file = Path.join(options.dir, STORE_FILE);
  const keyFile = Path.join(options.dir, KEY_FILE);

  let key: Buffer | undefined;
  let where: Sealed["key"] = "file";
  let entries: Entries = { config: {}, refs: {}, named: {} };
  let readable = true;

  if (Fs.existsSync(file)) {
    const sealed = readSealed(file);
    where = sealed?.key ?? "file";
    if (sealed !== undefined) {
      key =
        sealed.key === "keychain"
          ? decodeKey(await options.keychain?.get())
          : decodeKey(Fs.existsSync(keyFile) ? Fs.readFileSync(keyFile, "utf8") : undefined);
    }
    try {
      if (sealed === undefined || key === undefined) throw new Error("no key");
      entries = unseal(sealed, key);
    } catch {
      readable = false;
    }
  } else {
    key = Crypto.randomBytes(32);
    const encoded = key.toString("base64");
    if (
      options.keychain !== undefined &&
      (await options.keychain.set(encoded)) &&
      decodeKey(await options.keychain.get())?.equals(key) === true
    ) {
      where = "keychain";
    } else {
      if (options.keychain !== undefined) options.onKeychainRefused?.(options.keychain.kind);
      writeAtomically(keyFile, `${encoded}\n`);
    }
    writeAtomically(file, `${JSON.stringify(seal(entries, key, where))}\n`);
  }

  const persist = (next: Entries) => {
    writeAtomically(file, `${JSON.stringify(seal(next, key!, where))}\n`);
    entries = next;
  };
  const writable = () => {
    if (!readable) throw new SecretsError("SECRET_STORE_UNREADABLE");
  };
  const newId = () => Crypto.randomBytes(16).toString("hex");

  const removeRef = (id: string) => {
    const { [id]: _removed, ...refs } = entries.refs;
    persist({ ...entries, refs });
  };

  return {
    get readable() {
      return readable;
    },
    resolveConfig(reference: string, place: ConfigSecretPlace) {
      if (!readable || !CONFIG_SECRET_PATTERN.test(reference)) return undefined;
      const entry = entries.config[reference.slice("$secret:".length)];
      return entry !== undefined && entry.place === configSecretPlace(place)
        ? entry.value
        : undefined;
    },
    putConfig(value: string, place: ConfigSecretPlace) {
      writable();
      const id = newId();
      persist({
        ...entries,
        config: {
          ...entries.config,
          [id]: { place: configSecretPlace(place), value, savedAt: now() },
        },
      });
      return `$secret:${id}`;
    },
    deleteConfig(reference: string) {
      writable();
      if (!CONFIG_SECRET_PATTERN.test(reference)) return;
      const id = reference.slice("$secret:".length);
      if (!Object.hasOwn(entries.config, id)) return;
      const { [id]: _removed, ...config } = entries.config;
      persist({ ...entries, config });
    },
    putRef(value, owner) {
      writable();
      const id = newId();
      persist({
        ...entries,
        refs: {
          ...entries.refs,
          [id]: {
            projectId: owner.projectId,
            threadId: owner.threadId,
            value,
            savedAt: now(),
          },
        },
      });
      return `secret-ref:${id}`;
    },
    hasRef(ref: string) {
      return (
        readable &&
        SECRET_REF_PATTERN.test(ref) &&
        Object.hasOwn(entries.refs, ref.slice("secret-ref:".length))
      );
    },
    consumeRef({ ref, projectId }) {
      if (!SECRET_REF_PATTERN.test(ref)) throw new SecretsError("SECRET_REF_INVALID");
      writable();
      const id = ref.slice("secret-ref:".length);
      const entry = Object.hasOwn(entries.refs, id) ? entries.refs[id] : undefined;
      if (entry === undefined || entry.projectId !== projectId) {
        throw new SecretsError("SECRET_REF_UNAVAILABLE");
      }
      // One use: the entry is gone from the file before the value is handed out (D1031).
      removeRef(id);
      if (now() - entry.savedAt > SECRET_REF_TTL_MS) throw new SecretsError("SECRET_REF_EXPIRED");
      return entry.value;
    },
    getOrCreateRandom(name: string, bytes: number) {
      if (!readable) throw new SecretsError("SECRET_STORE_UNREADABLE");
      if (!/^[a-z0-9.-]+\/[a-z0-9.-]+$/.test(name) || !Number.isInteger(bytes) || bytes < 16) {
        throw new Error(`getOrCreateRandom needs <plugin>/<name> and at least 16 bytes`);
      }
      const kept = Object.hasOwn(entries.named, name) ? entries.named[name] : undefined;
      if (kept !== undefined) return kept.value;
      const value = Crypto.randomBytes(bytes).toString("base64url");
      persist({ ...entries, named: { ...entries.named, [name]: { value, savedAt: now() } } });
      return value;
    },
    status() {
      return {
        state: readable ? "ready" : "unreadable",
        key: where,
        keychain: where === "keychain" ? (options.keychain?.kind ?? null) : null,
        configSecrets: Object.keys(entries.config).length,
        openRefs: Object.keys(entries.refs).length,
      };
    },
    sweep() {
      if (!readable) return 0;
      const cutoff = now() - SECRET_REF_TTL_MS;
      const kept = Object.entries(entries.refs).filter(([, entry]) => entry.savedAt >= cutoff);
      const removed = Object.keys(entries.refs).length - kept.length;
      if (removed > 0) persist({ ...entries, refs: Object.fromEntries(kept) });
      return removed;
    },
  };
}
