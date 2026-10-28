// Refresh tokens of MCP clients (docs/plans/security.md D1519). T3 has none
// (`McpOAuth.ts` supports `authorization_code` only); this follows RFC 6749 §6,
// OAuth 2.1 §4.3 and RFC 9700 §4.14.2.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { z } from "@jhin/sdk";

/** A refresh token lives 90 days from its issue (D1519). */
const REFRESH_TTL_MS = 90 * 86_400_000;
/** Spent tokens a sign-in keeps to tell a reuse; an older one is refused as unknown. */
const MAX_SPENT_PER_SIGN_IN = 20;
/** How long after its spend a token may be presented again for a lost answer (D1705). */
const RETRY_WINDOW_MS = 60_000;

const RefreshRecord = z.object({
  /** SHA-256 of the token, base64url; the token itself is never kept. */
  hash: z.string(),
  /** The sign-in it belongs to: every token rotated from one code shares it. */
  family: z.string(),
  /** Used once already: presented again, it ends the sign-in. */
  spent: z.boolean(),
  /** When it was spent; a retry of a lost answer counts from it (D1705). */
  spentAt: z.number().optional(),
  expiresAt: z.number(),
  clientId: z.string(),
  clientName: z.string(),
  resource: z.string(),
  /** What the approver granted; a refresh may narrow it, never widen it. */
  scopes: z.array(z.string()),
  approver: z.object({ id: z.string() }),
  /** The device token it renews (`auth.clients.list`'s id). */
  tokenId: z.string(),
  /** When that device token expires: gone from the list before then means revoked. */
  tokenExpiresAt: z.number().optional(),
});
export type RefreshRecord = z.infer<typeof RefreshRecord>;

const File = z.object({ tokens: z.array(RefreshRecord) });

export type RefreshGrant = Omit<RefreshRecord, "hash" | "family" | "spent" | "expiresAt">;

const sha256 = (value: string) => Crypto.createHash("sha256").update(value).digest("base64url");

export type Lookup =
  | { readonly kind: "unknown" }
  | { readonly kind: "spent"; readonly family: string; readonly record: RefreshRecord }
  | { readonly kind: "ok"; readonly record: RefreshRecord };

/**
 * The refresh tokens of a node, kept as hashes in one file written whole and
 * renamed into place (mode 0600). Every change is written before it counts.
 */
export function createRefreshStore(options: {
  readonly file: string;
  readonly now?: () => number;
  readonly onCorrupt?: (error: string) => void;
}) {
  const now = options.now ?? Date.now;
  let records: RefreshRecord[] = [];
  if (Fs.existsSync(options.file)) {
    try {
      const parsed = File.safeParse(JSON.parse(Fs.readFileSync(options.file, "utf8")));
      if (parsed.success) records = parsed.data.tokens;
      else options.onCorrupt?.(parsed.error.message);
    } catch (error) {
      // Fails closed: every client signs in again.
      options.onCorrupt?.(String(error));
    }
  }

  const commit = (next: RefreshRecord[]) => {
    const at = now();
    // A sign-in keeps its last spent tokens only, so the file stays bounded
    // by the number of sign-ins however often a client refreshes.
    const spentSeen = new Map<string, number>();
    const kept = next
      .toReversed()
      .filter((record) => {
        if (record.expiresAt <= at) return false;
        if (!record.spent) return true;
        const seen = (spentSeen.get(record.family) ?? 0) + 1;
        spentSeen.set(record.family, seen);
        return seen <= MAX_SPENT_PER_SIGN_IN;
      })
      .toReversed();
    const temporary = `${options.file}.${process.pid}.tmp`;
    Fs.mkdirSync(Path.dirname(options.file), { recursive: true });
    Fs.writeFileSync(temporary, `${JSON.stringify({ tokens: kept }, null, 2)}\n`, {
      mode: 0o600,
    });
    Fs.renameSync(temporary, options.file);
    records = kept;
  };

  /** A sign-in's last token: its current one, or the spent one a refresh is renewing. */
  const latest = (family: string) => records.findLast((record) => record.family === family);

  return {
    /** A new refresh token for `grant`, in `family` (a new sign-in when absent). */
    issue(grant: RefreshGrant, family?: string): string {
      const token = Crypto.randomBytes(32).toString("base64url");
      commit([
        ...records,
        {
          ...grant,
          hash: sha256(token),
          family: family ?? Crypto.randomUUID(),
          spent: false,
          expiresAt: now() + REFRESH_TTL_MS,
        },
      ]);
      return token;
    },

    find(token: string): Lookup {
      const hash = sha256(token);
      const record = records.find((entry) => entry.hash === hash);
      if (record === undefined || record.expiresAt <= now()) return { kind: "unknown" };
      return record.spent
        ? { kind: "spent", family: record.family, record }
        : { kind: "ok", record };
    },

    /** Marks a token used, before anything is awaited: a second use is a reuse. */
    spend(hash: string): void {
      const at = now();
      commit(
        records.map((record) =>
          record.hash === hash ? { ...record, spent: true, spentAt: at } : record,
        ),
      );
    },

    /**
     * A spent token presented again by its client within the window, while the
     * token its spend issued is unused, is a retry of an answer that was lost
     * (D1705): forgets that unused token and returns it, so its access token is
     * revoked and the retry refreshes again. Anything else is a reuse.
     */
    retry(spent: RefreshRecord, clientId: string): RefreshRecord | undefined {
      if (spent.clientId !== clientId || spent.spentAt === undefined) return undefined;
      if (now() - spent.spentAt > RETRY_WINDOW_MS) return undefined;
      const family = records.filter((record) => record.family === spent.family);
      const issued = family.at(-1);
      // Issued by this spend and unused: the latest of the sign-in, right after it.
      if (issued === undefined || issued.spent || family.at(-2)?.hash !== spent.hash) {
        return undefined;
      }
      commit(records.filter((record) => record.hash !== issued.hash));
      return issued;
    },

    /** Whether the sign-in still exists (a reuse ends it while a refresh is under way). */
    alive(family: string): boolean {
      return records.some((record) => record.family === family);
    },

    /**
     * The sign-in whose latest token renews the device token `renews` matches.
     * Latest, not unspent: while a refresh is under way its spent token is the
     * latest, and revoking the access token it renews must still end the sign-in.
     */
    familyOf(renews: (tokenId: string) => boolean): string | undefined {
      const families = new Set(records.map((record) => record.family));
      return [...families].find((family) => renews(latest(family)!.tokenId));
    },

    /** Ends a sign-in: forgets its tokens and returns the device token it renews last. */
    end(family: string): string | undefined {
      const last = latest(family);
      if (last !== undefined) commit(records.filter((record) => record.family !== family));
      return last?.tokenId;
    },
  };
}
