import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { z } from "@jhin/sdk";

/** Device tokens are `jhd1.<id>.<secret>` (security.md D411). */
const DEVICE_TOKEN_PREFIX = "jhd1.";

export const ClientRecord = z.object({
  id: z.string(),
  label: z.string(),
  permissions: z.array(z.string()),
  /** How the token was given: by pairing a device, or issued by a command. */
  method: z.enum(["pairing", "issued"]),
  createdAt: z.number(),
  /** Absent: never expires. */
  expiresAt: z.number().optional(),
  lastSeenAt: z.number().optional(),
  /** SHA-256 of the secret, base64url; the secret itself is never kept. */
  secretHash: z.string(),
  /** The principal whose token opened it (a page session, D421): revoked with that one. */
  parent: z.string().optional(),
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
    now: number;
  }): { record: ClientRecord; token: string };
  /** The record a token belongs to, if the token is one of ours and still valid at `now`. */
  verify(token: string, now: number): ClientRecord | undefined;
  /** Removes records; returns the ones that were there. */
  remove(ids: readonly string[]): ClientRecord[];
}

/**
 * Reads the tokens kept in `file`. A file that does not parse gives no
 * access: it is moved aside to `<file>.corrupt` (and `onCorrupt` told), so
 * the node still starts and the next write does not silently replace it.
 */
export function createClientStore(
  file: string,
  onCorrupt: (moved: string, error: string) => void = () => {},
): ClientStore {
  let records: ClientRecord[] = [];
  if (Fs.existsSync(file)) {
    let error: string | undefined;
    try {
      const parsed = File.safeParse(JSON.parse(Fs.readFileSync(file, "utf8")));
      if (parsed.success) records = parsed.data.clients;
      else error = parsed.error.message;
    } catch (thrown) {
      error = String(thrown);
    }
    if (error !== undefined) {
      const moved = `${file}.corrupt`;
      Fs.renameSync(file, moved);
      onCorrupt(moved, error);
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

  return {
    list: () => records,
    get: (id) => records.find((record) => record.id === id),
    issue({ label, permissions, method, expiresAt, now, parent }) {
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
