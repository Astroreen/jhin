// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/FirefoxCookies.ts. docs/plans/preview.md, D1204.
import {
  CookieReadError,
  cookieScope,
  readSnapshot,
  withDatabase,
  type ImportedCookie,
} from "./cookie-database.ts";

/**
 * Unset is not the same thing as None (None is an explicit opt-in to cross-site
 * use), so it is imported as `unspecified`, which lets the target browser apply
 * its own default exactly as Firefox did. Anything unrecognised also lands there
 * rather than on `no_restriction`, since guessing "none" would widen a cookie's
 * scope on import.
 */
const SAMESITE_NONE = 0;
const SAMESITE_LAX = 1;
const SAMESITE_STRICT = 2;

/**
 * Schemas 10–14 carried a second column, `rawSameSite`: the value the cookie
 * actually declared, beside a `sameSite` that Firefox had already defaulted to
 * Lax. Reading such a database before Firefox has migrated it must apply the
 * same rule, or an undeclared cookie is imported as an explicit Lax.
 */
const FIREFOX_RAW_SAMESITE_FIRST_SCHEMA = 10;
const FIREFOX_RAW_SAMESITE_LAST_SCHEMA = 14;

/**
 * Firefox schema 16 (Firefox 129) moved `expiry` from seconds to milliseconds.
 * The unit is decided by `PRAGMA user_version` rather than assumed: importing a
 * pre-16 profile as milliseconds would expire every cookie at once, and a post-16
 * one as seconds would keep them for ~1000× too long.
 */
const FIREFOX_EXPIRY_MILLISECONDS_SCHEMA = 16;

const sameSiteFromColumn = (
  value: number | null,
  rawValue: number | null,
): ImportedCookie["sameSite"] => {
  // Schema 9 added the column with no default, so older rows carry NULL.
  if (value === null) return "unspecified";
  if (value === SAMESITE_LAX && rawValue === SAMESITE_NONE) return "unspecified";
  if (value === SAMESITE_NONE) return "no_restriction";
  if (value === SAMESITE_LAX) return "lax";
  if (value === SAMESITE_STRICT) return "strict";
  return "unspecified";
};

const expiryToSeconds = (expiry: number, schemaVersion: number): number | undefined => {
  if (expiry <= 0) return undefined;
  return schemaVersion >= FIREFOX_EXPIRY_MILLISECONDS_SCHEMA ? Math.floor(expiry / 1000) : expiry;
};

interface CookieRow {
  readonly host: string;
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly expiry: number;
  readonly isSecure: number;
  readonly isHttpOnly: number;
  readonly sameSite: number | null;
  readonly rawSameSite: number | null;
}

const isCookieRow = (row: Record<string, unknown>): boolean =>
  typeof row.host === "string" &&
  typeof row.name === "string" &&
  typeof row.value === "string" &&
  typeof row.path === "string" &&
  typeof row.expiry === "number" &&
  typeof row.isSecure === "number" &&
  typeof row.isHttpOnly === "number" &&
  (row.sameSite === null || typeof row.sameSite === "number") &&
  (row.rawSameSite === null || typeof row.rawSameSite === "number");

export function readFirefoxCookies(cookieDatabasePath: string): ReadonlyArray<ImportedCookie> {
  try {
    const { rows, schemaVersion } = readSnapshot(cookieDatabasePath, (snapshot) =>
      withDatabase(snapshot, (database) => {
        const version = database.prepare("pragma user_version").get()?.user_version;
        const userVersion = typeof version === "number" ? version : 0;
        const hasRawSameSite =
          userVersion >= FIREFOX_RAW_SAMESITE_FIRST_SCHEMA &&
          userVersion <= FIREFOX_RAW_SAMESITE_LAST_SCHEMA;
        // Firefox isolates cookies per container and per private window through
        // `originAttributes` (`^userContextId=2`, `^privateBrowsingId=1`); a
        // profile has no equivalent, so importing them all would collapse several
        // identities onto one host, name and path.
        const raw = database
          .prepare(
            `select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite,
               ${hasRawSameSite ? "rawSameSite" : "null as rawSameSite"}
             from moz_cookies where originAttributes = ''`,
          )
          .all();
        if (!raw.every(isCookieRow)) throw new Error("Unexpected Firefox cookie row");
        return { rows: raw as unknown as CookieRow[], schemaVersion: userVersion };
      }),
    );
    return rows.map((row) => {
      const secure = row.isSecure === 1;
      const scope = cookieScope(row.host, row.path, secure);
      return {
        url: scope.url,
        name: row.name,
        value: row.value,
        domain: scope.domain,
        path: row.path,
        secure,
        httpOnly: row.isHttpOnly === 1,
        expirationDate: expiryToSeconds(row.expiry, schemaVersion),
        sameSite: sameSiteFromColumn(row.sameSite, row.rawSameSite),
      } satisfies ImportedCookie;
    });
  } catch (cause) {
    throw new CookieReadError(
      "readFailed",
      `Could not read Firefox cookies at ${cookieDatabasePath}.`,
      {
        cause,
      },
    );
  }
}
