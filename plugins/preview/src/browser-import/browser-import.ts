// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/BrowserImport.ts (listing sources, checking a
// requested profile, reading and writing cookies). docs/plans/preview.md, D1204.
import {
  PreviewError,
  type BrowserImportFailureReason,
  type BrowserImportSource,
  type BrowserImportUnavailableReason,
  type PreviewImportCookiesInput,
  type PreviewImportCookiesResult,
} from "@jhin/preview-api";
import type { BrowserContext } from "playwright-core";

import { readChromiumCookies } from "./chromium-cookies.ts";
import { CookieReadError, type CookieReadResult, type ImportedCookie } from "./cookie-database.ts";
import { readFirefoxCookies } from "./firefox-cookies.ts";
import { nodeImportHost, sharingRuns, type ImportHost } from "./host.ts";
import { readSafariCookies, safariAccessDenied } from "./safari-cookies.ts";
import {
  BROWSER_IMPORT_SOURCES,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  resolveCookieDatabase,
  sourcePathContext,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
} from "./sources.ts";

/** At most this many skipped domains are reported (T3's). */
const SKIPPED_DOMAINS_LIMIT = 20;
/** Cookies are written in batches; a batch that fails is retried one cookie at a time. */
const WRITE_BATCH = 200;
/** Playwright refuses an expiry past 9999-12-31; Chromium caps one at 400 days anyway. */
const MAX_COOKIE_EXPIRES_SECONDS = 253_402_300_799;

/** An import that stopped: `details.reason` names why, for T3's copy in the client. */
export function importFailed(
  sourceId: string,
  reason: BrowserImportFailureReason,
  cause?: unknown,
): PreviewError {
  const error = new PreviewError(
    "PREVIEW_IMPORT_FAILED",
    `Importing cookies from ${sourceId} failed: ${reason}.`,
    { reason, sourceId },
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

async function unavailableReason(
  host: ImportHost,
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Promise<BrowserImportUnavailableReason | undefined> {
  if (!definition.platforms.includes(context.platform)) return "unsupportedPlatform";
  if (!(await isSourceInstalled(definition, context))) return "notInstalled";
  if (await isSourceRunning(host, definition, context)) return "browserRunning";
  // Safari's jar is found by `stat`, which TCC permits without Full Disk Access,
  // so a Safari that lists as ready may still refuse the read.
  if (definition.engine === "safari") {
    const jar = await resolveCookieDatabase(definition, context, ".");
    if (jar !== undefined && (await safariAccessDenied(jar))) return "needsFullDiskAccess";
  }
  return undefined;
}

/** The node machine's browsers, read for an import (D1204). */
export interface BrowserImport {
  listSources(): Promise<BrowserImportSource[]>;
  /** Reads a source profile's cookies; fails with `PREVIEW_IMPORT_FAILED`. */
  readCookies(
    input: Pick<PreviewImportCookiesInput, "sourceId" | "sourceProfileDirectory">,
  ): Promise<CookieReadResult>;
}

export function createBrowserImport(machine: ImportHost = nodeImportHost): BrowserImport {
  const host = sharingRuns(machine);
  return {
    async listSources() {
      const context = sourcePathContext(host);
      return Promise.all(
        BROWSER_IMPORT_SOURCES.map(async (definition) => {
          const unavailable = await unavailableReason(host, definition, context);
          return {
            id: definition.id,
            name: definition.name,
            profiles:
              unavailable === undefined ? [...(await listSourceProfiles(definition, context))] : [],
            ...(unavailable === undefined ? {} : { unavailable }),
          } satisfies BrowserImportSource;
        }),
      );
    },

    async readCookies(input) {
      const context = sourcePathContext(host);
      const definition = BROWSER_IMPORT_SOURCES.find(
        (candidate) => candidate.id === input.sourceId,
      );
      if (definition === undefined) throw importFailed(input.sourceId, "unknownSource");
      const blocked = await unavailableReason(host, definition, context);
      if (blocked !== undefined) throw importFailed(definition.id, blocked);

      // The profile folder arrives from a client, so it is only honoured when the
      // source itself reported it: forwarding it unchecked would let `..` segments
      // walk out of the browser's folder and read any cookie database on disk.
      const profiles = await listSourceProfiles(definition, context);
      const requested = profiles.find(
        (profile) => profile.directory === input.sourceProfileDirectory,
      );
      if (requested === undefined) throw importFailed(definition.id, "unknownSourceProfile");

      // Resolved again rather than assumed: a Chromium jar may sit under `Network/`.
      const databasePath = await resolveCookieDatabase(definition, context, requested.directory);
      if (databasePath === undefined) throw importFailed(definition.id, "readFailed");

      try {
        if (definition.engine === "safari") {
          return {
            cookies: await readSafariCookies(databasePath),
            undecryptable: 0,
            undecryptableHosts: [],
          };
        }
        if (definition.engine === "firefox") {
          return {
            cookies: readFirefoxCookies(databasePath),
            undecryptable: 0,
            undecryptableHosts: [],
          };
        }
        const userDataDirectory = definition.userDataDirectory(context);
        return await readChromiumCookies(host, {
          cookieDatabasePath: databasePath,
          keychainService: definition.keychainService,
          keychainAccount: definition.keychainAccount,
          linuxSecretApplication: definition.linuxSecretApplication,
          windowsLocalStatePath:
            host.platform === "win32" && userDataDirectory !== undefined
              ? context.path.join(userDataDirectory, "Local State")
              : undefined,
        });
      } catch (cause) {
        throw importFailed(
          definition.id,
          cause instanceof CookieReadError ? cause.reason : "readFailed",
          cause,
        );
      }
    },
  };
}

type PlaywrightCookie = Parameters<BrowserContext["addCookies"]>[0][number];

/**
 * A read cookie as Playwright's: a host-only cookie gets its bare host as
 * `domain` (Chromium keeps a domain without a leading dot host-only, which
 * `__Host-` cookies need), a domain cookie keeps its dot. Its URL is not passed:
 * Playwright would replace the path with the URL's folder.
 */
export function toPlaywrightCookie(cookie: ImportedCookie): PlaywrightCookie {
  const domain = cookie.domain ?? new URL(cookie.url).hostname;
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expirationDate === undefined
      ? {}
      : { expires: Math.min(cookie.expirationDate, MAX_COOKIE_EXPIRES_SECONDS) }),
    // Unspecified is left out, so the profile applies its default as the source did.
    ...(cookie.sameSite === "no_restriction"
      ? { sameSite: "None" as const }
      : cookie.sameSite === "lax"
        ? { sameSite: "Lax" as const }
        : cookie.sameSite === "strict"
          ? { sameSite: "Strict" as const }
          : {}),
  };
}

const cookieHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const cookieKey = (cookie: { name: string; domain?: string; path?: string; value: string }) =>
  JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.value]);

/** A context or browser that went away fails every write: the profile is gone, not the cookie. */
const isClosed = (error: unknown): boolean =>
  /has been closed|Target closed|Browser closed/i.test(
    error instanceof Error ? error.message : String(error),
  );

/**
 * One cookie per name, domain and path, the last read winning, as writing them
 * in order would leave it: an overwritten duplicate is neither imported twice
 * nor skipped.
 */
function distinctCookies(cookies: ReadonlyArray<ImportedCookie>): {
  readonly cookies: ImportedCookie[];
  readonly invalid: ImportedCookie[];
} {
  const byScope = new Map<string, ImportedCookie>();
  const invalid: ImportedCookie[] = [];
  for (const cookie of cookies) {
    let mapped: PlaywrightCookie;
    try {
      mapped = toPlaywrightCookie(cookie);
    } catch {
      invalid.push(cookie);
      continue;
    }
    const scope = JSON.stringify([mapped.name, mapped.domain, mapped.path]);
    byScope.delete(scope);
    byScope.set(scope, cookie);
  }
  return { cookies: [...byScope.values()], invalid };
}

/**
 * Writes read cookies into a profile's context. A rejected cookie costs only
 * itself: it is counted as skipped with its domain, as is every cookie that
 * could not be decrypted. Chromium drops a cookie it refuses (SameSite=None
 * without Secure, a bad prefix) without an error, so what was written is read
 * back: only a cookie the profile now holds, with its value, counts as imported.
 */
export async function writeCookies(
  context: Pick<BrowserContext, "addCookies" | "cookies">,
  read: CookieReadResult,
): Promise<PreviewImportCookiesResult> {
  let skipped = read.undecryptable;
  const skippedDomains = new Set(read.undecryptableHosts);
  const skip = (cookie: ImportedCookie) => {
    skipped += 1;
    skippedDomains.add(cookieHost(cookie.url));
  };
  const { cookies, invalid } = distinctCookies(read.cookies);
  invalid.forEach(skip);
  const written: Array<{ cookie: ImportedCookie; key: string }> = [];
  const writeOne = async (cookie: ImportedCookie) => {
    try {
      const mapped = toPlaywrightCookie(cookie);
      await context.addCookies([mapped]);
      written.push({ cookie, key: cookieKey(mapped) });
    } catch (error) {
      if (isClosed(error)) throw error;
      skip(cookie);
    }
  };
  for (let start = 0; start < cookies.length; start += WRITE_BATCH) {
    const batch = cookies.slice(start, start + WRITE_BATCH);
    try {
      const mapped = batch.map(toPlaywrightCookie);
      await context.addCookies(mapped);
      batch.forEach((cookie, index) => written.push({ cookie, key: cookieKey(mapped[index]!) }));
    } catch (error) {
      if (isClosed(error)) throw error;
      // Setting a cookie again overwrites it, so a batch partly written is safe to redo.
      for (const cookie of batch) await writeOne(cookie);
    }
  }
  let imported = 0;
  if (written.length > 0) {
    const held = new Set((await context.cookies()).map(cookieKey));
    for (const { cookie, key } of written) {
      if (held.has(key)) imported += 1;
      else skip(cookie);
    }
  }
  return { imported, skipped, skippedDomains: [...skippedDomains].slice(0, SKIPPED_DOMAINS_LIMIT) };
}
