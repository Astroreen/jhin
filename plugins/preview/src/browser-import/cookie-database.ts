// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/CookieDatabase.ts. docs/plans/preview.md, D1204.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BrowserImportFailureReason } from "@jhin/preview-api";

/** A cookie read from a browser, before it is written into a profile. */
export interface ImportedCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /**
   * A host-only cookie leaves this undefined: a `domain` marks a domain cookie,
   * which would widen the cookie to every subdomain of the host it was scoped to,
   * and `__Host-` cookies require it to be absent.
   */
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Seconds since the UNIX epoch; undefined for a session cookie. */
  readonly expirationDate: number | undefined;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface CookieReadResult {
  readonly cookies: ReadonlyArray<ImportedCookie>;
  readonly undecryptable: number;
  readonly undecryptableHosts: ReadonlyArray<string>;
}

/** Why reading a browser's cookies stopped (T3's tagged read errors, one class here). */
export class CookieReadError extends Error {
  readonly reason: BrowserImportFailureReason;

  constructor(reason: BrowserImportFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CookieReadError";
    this.reason = reason;
  }
}

export const bareHost = (host: string): string => (host.startsWith(".") ? host.slice(1) : host);

export const cookieScope = (
  host: string,
  path: string,
  secure: boolean,
): { readonly url: string; readonly domain: string | undefined } => {
  const isDomainCookie = host.startsWith(".");
  const unwrappedHost = bareHost(host);
  const authority =
    unwrappedHost.includes(":") && !(unwrappedHost.startsWith("[") && unwrappedHost.endsWith("]"))
      ? `[${unwrappedHost}]`
      : unwrappedHost;
  return {
    url: `${secure ? "https" : "http"}://${authority}${path}`,
    domain: isDomainCookie ? host : undefined,
  };
};

/** Runs `read` on a read-only connection to a database, closed afterwards. */
export function withDatabase<T>(filename: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

interface CookieSnapshot {
  readonly path: string;
  /** Removes the snapshot's temporary folder. */
  dispose(): void;
}

/**
 * Both engines keep the file open with WAL while the browser runs, so reading in
 * place can observe a torn write. Copying with `VACUUM INTO` also guarantees the
 * browser's own file is never opened for writing.
 */
export function snapshotCookieDatabase(
  cookiePath: string,
  tempPrefix = "jhin-cookie-import-",
): CookieSnapshot {
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), tempPrefix));
  const dispose = () => Fs.rmSync(directory, { recursive: true, force: true });
  const target = Path.join(directory, Path.basename(cookiePath));
  try {
    withDatabase(cookiePath, (database) => database.prepare("VACUUM INTO ?").run(target));
  } catch (cause) {
    dispose();
    throw cause;
  }
  return { path: target, dispose };
}

/** Reads a snapshot of a cookie database, removed once `read` is done. */
export function readSnapshot<T>(cookiePath: string, read: (snapshotPath: string) => T): T {
  const snapshot = snapshotCookieDatabase(cookiePath);
  try {
    return read(snapshot.path);
  } finally {
    snapshot.dispose();
  }
}
