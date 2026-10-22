// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/SafariCookies.ts. docs/plans/preview.md, D1204.
import * as Fs from "node:fs";

import { CookieReadError, cookieScope, type ImportedCookie } from "./cookie-database.ts";

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/** `u32 0x00000100`, `u32le cookieCount`, then one `u32le` offset per cookie. */
const COOKIE_PAGE_HEADER_SIZE = 12;
const COOKIE_RECORD_HEADER_SIZE = 56;

const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

const malformed = () => new CookieReadError("readFailed", "Malformed Safari cookie jar.");

function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

/** Parses `Cookies.binarycookies`; anything out of bounds rejects the whole jar. */
export function parseBinaryCookies(buffer: Buffer): ReadonlyArray<ImportedCookie> {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") throw malformed();

  const pageCount = buffer.readUInt32BE(4);
  // `Buffer.subarray` clamps silently, so accepting a short page or an overlong
  // record would return a cookie set quietly missing entries or carrying fields
  // read out of the next record: a partial import the user has no way to notice.
  if (8 + pageCount * 4 > buffer.length) throw malformed();
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(buffer.readUInt32BE(8 + index * 4));
  }

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > buffer.length) {
      throw malformed();
    }
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;

    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = page.readUInt32LE(4);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > page.length) throw malformed();
    // Every record accepted so far, so a later offset cannot point back into one
    // of them: the page header, the offset table and earlier records are all
    // bytes that would otherwise parse as a fabricated cookie.
    const accepted: Array<readonly [start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > page.length) {
        throw malformed();
      }
      const recordSize = page.readUInt32LE(cookieStart);
      const cookieEnd = cookieStart + recordSize;
      if (
        recordSize < COOKIE_RECORD_HEADER_SIZE ||
        cookieEnd > page.length ||
        accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)
      ) {
        throw malformed();
      }
      accepted.push([cookieStart, cookieEnd]);
      const cookie = page.subarray(cookieStart, cookieEnd);

      const flags = cookie.readUInt32LE(8);
      const urlOffset = cookie.readUInt32LE(16);
      const nameOffset = cookie.readUInt32LE(20);
      const pathOffset = cookie.readUInt32LE(24);
      const valueOffset = cookie.readUInt32LE(28);
      const expiry = cookie.readDoubleLE(40);

      if (
        [urlOffset, nameOffset, pathOffset, valueOffset].some(
          (offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookie.length,
        )
      ) {
        throw malformed();
      }
      const domain = readCString(cookie, urlOffset);
      const name = readCString(cookie, nameOffset);
      const path = readCString(cookie, pathOffset);
      const value = readCString(cookie, valueOffset);
      if (domain === "" || name === "") continue;

      const secure = (flags & FLAG_SECURE) !== 0;
      cookies.push({
        // Safari marks domain cookies with a leading dot like the other engines,
        // so the shared scope rule applies: host-only cookies keep `domain`
        // undefined, or they widen to every subdomain.
        ...cookieScope(domain, path || "/", secure),
        name,
        value,
        path: path || "/",
        secure,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        expirationDate: expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined,
        // Bits 3–5 of the flags carry something SameSite-shaped, but no public
        // description of them agrees and real jars match none of them cleanly.
        // Lax is the modern browser default; claiming "none" would widen every
        // imported cookie's scope.
        sameSite: "lax",
      });
    }
  }

  // Safari writes an 8-byte checksum after the pages, then an optional
  // length-prefixed property list.
  const trailer = buffer.length - pageStart;
  const validTrailer =
    trailer === 0 ||
    trailer === 8 ||
    (trailer >= 12 && trailer === 8 + 4 + buffer.readUInt32BE(pageStart + 8));
  if (!validTrailer) throw malformed();

  return cookies;
}

/**
 * TCC denies with EPERM. EACCES is an ordinary POSIX permission or ACL failure
 * that granting Full Disk Access cannot fix, so it stays a plain read failure.
 */
export const isPermissionDenied = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "EPERM";

/**
 * `stat` succeeds on the jar inside Safari's container even without Full Disk
 * Access (that is what lets the listing find it), so only an open tells granted
 * from denied.
 */
export async function safariAccessDenied(cookiePath: string): Promise<boolean> {
  try {
    const handle = await Fs.promises.open(cookiePath, "r");
    await handle.close();
    return false;
  } catch (cause) {
    return isPermissionDenied(cause);
  }
}

export async function readSafariCookies(
  cookiePath: string,
): Promise<ReadonlyArray<ImportedCookie>> {
  let contents: Buffer;
  try {
    contents = await Fs.promises.readFile(cookiePath);
  } catch (cause) {
    throw new CookieReadError(
      isPermissionDenied(cause) ? "needsFullDiskAccess" : "readFailed",
      `Could not read Safari cookies at ${cookiePath}.`,
      { cause },
    );
  }
  try {
    return parseBinaryCookies(contents);
  } catch (cause) {
    throw new CookieReadError("readFailed", `Could not read Safari cookies at ${cookiePath}.`, {
      cause,
    });
  }
}
