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
    now: number;
  }): { record: ClientRecord; token: string };
  /** The record a token belongs to, if the token is one of ours and still valid at `now`. */
  verify(token: string, now: number): ClientRecord | undefined;
  /** Removes records; returns the ones that were there. */
  remove(ids: readonly string[]): ClientRecord[];
}

export function createClientStore(file: string): ClientStore {
  let records: ClientRecord[] = [];
  if (Fs.existsSync(file)) {
    const parsed = File.safeParse(JSON.parse(Fs.readFileSync(file, "utf8")));
    // A file we cannot read gives no access, rather than someone else's.
    if (parsed.success) records = parsed.data.clients;
  }
  const save = () => {
    const temporary = `${file}.${process.pid}.tmp`;
    Fs.mkdirSync(Path.dirname(file), { recursive: true });
    Fs.writeFileSync(temporary, `${JSON.stringify({ clients: records }, null, 2)}\n`, {
      mode: 0o600,
    });
    Fs.renameSync(temporary, file);
  };

  return {
    list: () => records,
    get: (id) => records.find((record) => record.id === id),
    issue({ label, permissions, method, expiresAt, now }) {
      const id = Crypto.randomBytes(9).toString("base64url");
      const secret = Crypto.randomBytes(32).toString("base64url");
      const record: ClientRecord = {
        id,
        label,
        permissions: [...permissions],
        method,
        createdAt: now,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        secretHash: hash(secret),
      };
      records = [...records, record];
      save();
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
      const seen: ClientRecord = { ...record, lastSeenAt: now };
      records = records.map((entry) => (entry === record ? seen : entry));
      save();
      return seen;
    },
    remove(ids) {
      const gone = records.filter((record) => ids.includes(record.id));
      if (gone.length > 0) {
        records = records.filter((record) => !ids.includes(record.id));
        save();
      }
      return gone;
    },
  };
}
