import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { z } from "@jhin/sdk";

import { ClientMetadata } from "./metadata.ts";

/** Device tokens are `jhd1.<id>.<secret>` (security.md D411). */
const DEVICE_TOKEN_PREFIX = "jhd1.";

export const ClientRecord = z.object({
  id: z.string(),
  label: z.string(),
  permissions: z.array(z.string()),
  /** How the token was given: by pairing a device, or issued by a command. */
  method: z.enum(["pairing", "issued", "oauth"]),
  createdAt: z.number(),
  /** Absent: never expires. */
  expiresAt: z.number().optional(),
  lastSeenAt: z.number().optional(),
  /** SHA-256 of the secret, base64url; the secret itself is never kept. */
  secretHash: z.string(),
  /** The principal whose token opened it (a page session, D421): revoked with that one. */
  parent: z.string().optional(),
  /** What the device said about itself when it paired (security.md D1187). */
  metadata: ClientMetadata.optional(),
  /**
   * The RFC 7638 thumbprint of the key the token is bound to (DPoP,
   * security.md D1366): the token is then only used with a proof.
   */
  jkt: z.string().optional(),
});
export type ClientRecord = z.infer<typeof ClientRecord>;

const File = z.object({ clients: z.array(ClientRecord) });

const hash = (secret: string) => Crypto.createHash("sha256").update(secret).digest("base64url");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && Crypto.timingSafeEqual(left, right);
}

/** The device tokens of a node, kept in one file written whole. */
export interface ClientStore {
  list(): readonly ClientRecord[];
  get(id: string): ClientRecord | undefined;
  /** Creates a record and returns its token, the only time it exists in clear. */
  issue(input: {
    label: string;
    permissions: readonly string[];
    method: ClientRecord["method"];
    expiresAt?: number;
    parent?: string;
    metadata?: ClientMetadata;
    jkt?: string;
    now: number;
  }): { record: ClientRecord; token: string };
  /** The record a token belongs to, if the token is one of ours and still valid at `now`. */
  verify(token: string, now: number): ClientRecord | undefined;
  /** Removes records; returns the ones that were there. */
  remove(ids: readonly string[]): ClientRecord[];
}

/** What repairing an unreadable `clients.json` did (security.md D1518). */
export interface ClientRepair {
  /** Where the unreadable file was kept: `<file>.corrupt-<time>`; absent when it could not be. */
  readonly moved?: string;
  /** Why the file did not read whole. */
  readonly error: string;
  /** Records that read on their own and were still valid. */
  readonly kept: number;
  /** Records that did not read (or not as a record), dropped. */
  readonly unreadable: number;
  /** Records that read but had expired, dropped. */
  readonly expired: number;
  /**
   * Why the repair could not be written. Then nothing is accepted, as
   * before D1518: the unreadable file is moved aside and `kept` is 0.
   */
  readonly failed?: string;
}

/** Where a record starts as the node writes one: `{` and its `id` first. */
const RECORD_START = /\{\s*"id"\s*:/y;

/**
 * The end (exclusive) of the JSON object that starts at `start` (a `{`),
 * or -1 when the text ends before it closes. Braces in strings do not count.
 */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Every record an unreadable file still proves (security.md D1518): the
 * entries of its `clients` list when it is JSON, else every JSON object in
 * its text that reads as a record. Each is checked against the schema on
 * its own; expired ones are dropped, and an id is kept once.
 */
function salvageClients(
  text: string,
  now: number,
): { kept: ClientRecord[]; unreadable: number; expired: number } {
  let candidates: unknown[] | undefined;
  try {
    const parsed = JSON.parse(text) as { clients?: unknown } | null;
    if (Array.isArray(parsed?.clients)) candidates = parsed.clients;
  } catch {
    // Not JSON: its objects are read one by one below.
  }
  const kept: ClientRecord[] = [];
  let expired = 0;
  let unreadable = 0;
  const take = (candidate: unknown): boolean => {
    const record = ClientRecord.safeParse(candidate);
    if (!record.success) return false;
    if (record.data.expiresAt !== undefined && record.data.expiresAt <= now) expired += 1;
    else if (!kept.some((other) => other.id === record.data.id)) kept.push(record.data);
    return true;
  };
  if (candidates !== undefined) {
    for (const candidate of candidates) if (!take(candidate)) unreadable += 1;
    return { kept, unreadable, expired };
  }
  let index = text.indexOf("{");
  while (index >= 0) {
    const end = objectEnd(text, index);
    let next = index + 1;
    let read = false;
    if (end > 0) {
      try {
        // A record read whole: the search goes on after it, not inside it.
        read = take(JSON.parse(text.slice(index, end)));
        if (read) next = end;
      } catch {
        // Not an object on its own: one inside it may be.
      }
    }
    // An object that starts as a record does (a string's `{"id"` is escaped
    // in the file, so it never does) but did not read is one lost.
    RECORD_START.lastIndex = index;
    if (!read && RECORD_START.test(text)) unreadable += 1;
    index = text.indexOf("{", next);
  }
  return { kept, unreadable, expired };
}

/** `<file>.corrupt-<time>`, then `-1`, `-2`… */
function* corruptNames(file: string, now: number): Generator<string, never> {
  const time = new Date(now).toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; ; attempt += 1) {
    yield `${file}.corrupt-${time}${attempt === 0 ? "" : `-${attempt}`}`;
  }
}

/**
 * Copies `file` to the first free `<file>.corrupt-<time>` name, never over
 * one that exists: a name taken meanwhile (`EEXIST`) moves on to the next.
 */
function copyAside(file: string, now: number): string {
  for (const name of corruptNames(file, now)) {
    try {
      Fs.copyFileSync(file, name, Fs.constants.COPYFILE_EXCL);
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("unreachable");
}

/** The first `<file>.corrupt-<time>` name nothing has. */
function freeCorruptName(file: string, now: number): string {
  for (const name of corruptNames(file, now)) if (!Fs.existsSync(name)) return name;
  throw new Error("unreachable");
}

/**
 * Reads the tokens kept in `file`. A file that does not read whole is
 * repaired from itself (security.md D1518): the records it still proves
 * are written as the new file, the unreadable one is kept beside it as
 * `<file>.corrupt-<time>`, and `onRepaired` is told once. No older copy is
 * ever read, so a revoked token (whose record a revoke removed) cannot
 * come back.
 */
export function createClientStore(
  file: string,
  onRepaired: (repair: ClientRepair) => void = () => {},
  clock: () => number = Date.now,
): ClientStore {
  let records: ClientRecord[] = [];
  let repair: Omit<ClientRepair, "moved"> | undefined;
  if (Fs.existsSync(file)) {
    const text = Fs.readFileSync(file, "utf8");
    let error: string | undefined;
    try {
      const parsed = File.safeParse(JSON.parse(text));
      if (parsed.success) records = parsed.data.clients;
      else error = parsed.error.message;
    } catch (thrown) {
      error = String(thrown);
    }
    if (error !== undefined) {
      const salvaged = salvageClients(text, clock());
      records = salvaged.kept;
      repair = {
        error,
        kept: salvaged.kept.length,
        unreadable: salvaged.unreadable,
        expired: salvaged.expired,
      };
    }
  }
  /**
   * Writes `next` and only then makes it current: a failed write changes
   * nothing, so a revoke that throws has revoked nothing either.
   */
  const commit = (next: ClientRecord[]) => {
    const temporary = `${file}.${process.pid}.tmp`;
    Fs.mkdirSync(Path.dirname(file), { recursive: true });
    Fs.writeFileSync(temporary, `${JSON.stringify({ clients: next }, null, 2)}\n`, {
      mode: 0o600,
    });
    Fs.renameSync(temporary, file);
    records = next;
  };
  if (repair !== undefined) {
    // The unreadable file stays beside the new one, as it was; a copy, so the
    // name never replaces one an earlier repair kept.
    let moved: string | undefined;
    let failed: string | undefined;
    try {
      moved = copyAside(file, clock());
      Fs.chmodSync(moved, 0o600);
      commit(records);
    } catch (thrown) {
      failed = String(thrown);
    }
    if (failed !== undefined) {
      // A repair that cannot be written never stops the node (and its owner
      // token) from starting: nothing is accepted, and the unreadable file is
      // moved aside so a later write does not silently replace it.
      records = [];
      try {
        const target = moved ?? freeCorruptName(file, clock());
        Fs.renameSync(file, target);
        moved = target;
      } catch {
        // It stays where it is; the warning says so by naming no copy.
      }
    }
    onRepaired({
      ...(moved === undefined ? {} : { moved }),
      ...repair,
      ...(failed === undefined ? {} : { kept: 0, failed }),
    });
  }

  return {
    list: () => records,
    get: (id) => records.find((record) => record.id === id),
    issue({ label, permissions, method, expiresAt, now, parent, metadata, jkt }) {
      const id = Crypto.randomBytes(9).toString("base64url");
      const secret = Crypto.randomBytes(32).toString("base64url");
      const record: ClientRecord = {
        id,
        label,
        permissions: [...permissions],
        method,
        createdAt: now,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(parent === undefined ? {} : { parent }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(jkt === undefined ? {} : { jkt }),
        secretHash: hash(secret),
      };
      // Expired tokens go with the next write; nothing can use them any more.
      commit([
        ...records.filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now),
        record,
      ]);
      return { record, token: `${DEVICE_TOKEN_PREFIX}${id}.${secret}` };
    },
    verify(token, now) {
      if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return undefined;
      const rest = token.slice(DEVICE_TOKEN_PREFIX.length);
      const dot = rest.indexOf(".");
      if (dot <= 0) return undefined;
      const record = records.find((entry) => entry.id === rest.slice(0, dot));
      if (record === undefined || !sameHash(hash(rest.slice(dot + 1)), record.secretHash)) {
        return undefined;
      }
      if (record.expiresAt !== undefined && record.expiresAt <= now) return undefined;
      // Kept in memory and written with the next change: a login never waits
      // for, or fails on, the disk.
      const seen: ClientRecord = { ...record, lastSeenAt: now };
      records = records.map((entry) => (entry === record ? seen : entry));
      return seen;
    },
    remove(ids) {
      const gone = records.filter((record) => ids.includes(record.id));
      if (gone.length > 0) {
        commit(records.filter((record) => !ids.includes(record.id)));
      }
      return gone;
    },
  };
}
