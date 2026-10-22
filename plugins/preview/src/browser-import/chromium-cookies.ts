// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/ChromiumCookies.ts. docs/plans/preview.md, D1204.
import * as Crypto from "node:crypto";

import {
  ChromiumKeyError,
  readWindowsKey,
  resolveChromiumKeys,
  type ChromiumKeyMaterial,
} from "./chromium-keys.ts";
import {
  CookieReadError,
  bareHost,
  cookieScope,
  readSnapshot,
  withDatabase,
  type CookieReadResult,
  type ImportedCookie,
} from "./cookie-database.ts";
import type { ImportHost } from "./host.ts";

/** OSCrypt's CBC mode uses a fixed IV of 16 spaces rather than a per-record one. */
const AES_CBC_IV = Buffer.alloc(16, 0x20);
const AES_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;

/**
 * Unspecified stays unspecified rather than pinned to Lax, so the target browser
 * applies its default just as the source did; anything unrecognised lands there
 * too, since guessing "none" would widen a cookie's scope on import.
 */
const sameSiteFromColumn = (value: number): ImportedCookie["sameSite"] => {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
};

/**
 * The microsecond value overflows JavaScript's safe integer range and
 * `node:sqlite` refuses to narrow it, so the division happens in SQL and this
 * only ever sees seconds.
 */
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const toUnixSeconds = (webkitSeconds: number): number | undefined =>
  webkitSeconds <= 0 ? undefined : webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS;

/** Chromium >= 127 prefixes the plaintext with SHA-256 of the host key, binding a cookie to its domain. */
const stripDomainBinding = (
  plaintext: Buffer,
  domain: string,
  schemaVersion: number,
): Buffer | null => {
  if (schemaVersion < 24) return plaintext;
  const domainHash = Crypto.createHash("sha256").update(domain).digest();
  return plaintext.length >= 32 && plaintext.subarray(0, 32).equals(domainHash)
    ? plaintext.subarray(32)
    : null;
};

const decryptCbc = (
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number,
): string | null => {
  try {
    const decipher = Crypto.createDecipheriv("aes-128-cbc", key, AES_CBC_IV);
    decipher.setAutoPadding(true);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
};

const decryptGcm = (
  payload: Buffer,
  key: Buffer,
  domain: string,
  schemaVersion: number,
): string | null => {
  if (payload.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) return null;
  try {
    const nonce = payload.subarray(0, AES_GCM_NONCE_LENGTH);
    const ciphertext = payload.subarray(AES_GCM_NONCE_LENGTH, -AES_GCM_TAG_LENGTH);
    const tag = payload.subarray(-AES_GCM_TAG_LENGTH);
    const decipher = Crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripDomainBinding(plaintext, domain, schemaVersion)?.toString("utf8") ?? null;
  } catch {
    return null;
  }
};

export function decryptChromiumValue(
  encrypted: Uint8Array,
  keys: ChromiumKeyMaterial,
  domain: string,
  schemaVersion = 23,
  platform: NodeJS.Platform = "linux",
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return "";
  const prefix = buffer.subarray(0, 3).toString("latin1");
  const payload = buffer.subarray(3);

  // Windows' legacy v10 format is AES-256-GCM. App-bound records use v20 and
  // intentionally have no key here, so they fall through as undecryptable.
  if (platform === "win32") {
    return prefix === "v10" && keys.gcmV10
      ? decryptGcm(payload, keys.gcmV10, domain, schemaVersion)
      : null;
  }

  // Chromium retries a failed record with a key derived from an empty
  // passphrase, because some Linux clients wrote data that way (crbug.com/1195256).
  if (prefix === "v10" || prefix === "v11") {
    const key = prefix === "v10" ? keys.cbcV10 : keys.cbcV11;
    if (!key) return null;
    return (
      decryptCbc(payload, key, domain, schemaVersion) ??
      (keys.cbcEmpty ? decryptCbc(payload, keys.cbcEmpty, domain, schemaVersion) : null)
    );
  }
  if (platform === "darwin" || platform === "linux") {
    return stripDomainBinding(buffer, domain, schemaVersion)?.toString("utf8") ?? null;
  }
  return null;
}

interface CookieRow {
  readonly host_key: string;
  readonly name: string;
  readonly value: string;
  readonly encrypted_value: Uint8Array;
  readonly path: string;
  readonly expires_seconds: number;
  readonly is_secure: number;
  readonly is_httponly: number;
  readonly samesite: number;
  readonly top_frame_site_key: string;
}

/** `meta.version` as a non-negative integer, stored as either an integer or its text. */
function schemaVersionOf(value: unknown): number {
  const version =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Unreadable Chromium cookie schema version: ${String(value)}`);
  }
  return version;
}

function isCookieRow(row: Record<string, unknown>): boolean {
  return (
    typeof row.host_key === "string" &&
    typeof row.name === "string" &&
    typeof row.value === "string" &&
    row.encrypted_value instanceof Uint8Array &&
    typeof row.path === "string" &&
    typeof row.expires_seconds === "number" &&
    typeof row.is_secure === "number" &&
    typeof row.is_httponly === "number" &&
    typeof row.samesite === "number" &&
    typeof row.top_frame_site_key === "string"
  );
}

/** Reads a Chromium cookie database (a snapshot of it) with the given keys. */
export function readChromiumCookieDatabase(
  snapshotPath: string,
  keys: ChromiumKeyMaterial,
  platform: NodeJS.Platform,
): CookieReadResult {
  const { rows, schemaVersion } = withDatabase(snapshotPath, (database) => {
    const meta = database.prepare("select value from meta where key = 'version' limit 1").get();
    const version = schemaVersionOf(meta?.value);
    const partition = version >= 15 ? "top_frame_site_key" : "'' as top_frame_site_key";
    const raw = database
      .prepare(
        `select host_key, name, value, encrypted_value, path,
           expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
           samesite, ${partition} from cookies`,
      )
      .all();
    if (!raw.every(isCookieRow)) throw new Error("Unexpected Chromium cookie row");
    return { rows: raw as unknown as CookieRow[], schemaVersion: version };
  });

  const cookies: ImportedCookie[] = [];
  let undecryptable = 0;
  const undecryptableHosts = new Set<string>();
  for (const row of rows) {
    // A partitioned (CHIPS) cookie belongs to one top-level site; a profile's
    // `addCookies` has no partition key, so it would leak across sites.
    if (row.top_frame_site_key !== "") {
      undecryptable += 1;
      undecryptableHosts.add(bareHost(row.host_key));
      continue;
    }
    const value =
      row.encrypted_value.length === 0
        ? row.value
        : decryptChromiumValue(row.encrypted_value, keys, row.host_key, schemaVersion, platform);
    if (value === null) {
      undecryptable += 1;
      undecryptableHosts.add(bareHost(row.host_key));
      continue;
    }
    const secure = row.is_secure === 1;
    const scope = cookieScope(row.host_key, row.path, secure);
    cookies.push({
      url: scope.url,
      name: row.name,
      value,
      domain: scope.domain,
      path: row.path,
      secure,
      httpOnly: row.is_httponly === 1,
      expirationDate: toUnixSeconds(row.expires_seconds),
      sameSite: sameSiteFromColumn(row.samesite),
    });
  }
  if (
    cookies.length === 0 &&
    keys.cbcV11Error !== undefined &&
    rows.some(
      (row) =>
        row.top_frame_site_key === "" &&
        Buffer.from(row.encrypted_value.subarray(0, 3)).toString("latin1") === "v11",
    )
  ) {
    throw keys.cbcV11Error;
  }
  return { cookies, undecryptable, undecryptableHosts: [...undecryptableHosts] };
}

export interface ChromiumCookieSource {
  readonly cookieDatabasePath: string;
  readonly keychainService: string | undefined;
  readonly keychainAccount: string | undefined;
  readonly linuxSecretApplication: string | undefined;
  readonly windowsLocalStatePath?: string | undefined;
}

const readError = (cookieDatabasePath: string, cause: unknown) =>
  new CookieReadError(
    cause instanceof ChromiumKeyError ? cause.reason : "readFailed",
    `Could not read Chromium cookies at ${cookieDatabasePath}.`,
    { cause },
  );

export async function readChromiumCookies(
  host: ImportHost,
  source: ChromiumCookieSource,
): Promise<CookieReadResult> {
  let keys: ChromiumKeyMaterial;
  try {
    keys =
      host.platform === "win32" && source.windowsLocalStatePath
        ? { gcmV10: await readWindowsKey(host, source.windowsLocalStatePath) }
        : await resolveChromiumKeys(host, {
            platform: host.platform,
            keychainService: source.keychainService,
            keychainAccount: source.keychainAccount,
            linuxSecretApplication: source.linuxSecretApplication,
          });
  } catch (cause) {
    throw readError(source.cookieDatabasePath, cause);
  }
  try {
    return readSnapshot(source.cookieDatabasePath, (snapshot) =>
      readChromiumCookieDatabase(snapshot, keys, host.platform),
    );
  } catch (cause) {
    throw readError(source.cookieDatabasePath, cause);
  }
}
