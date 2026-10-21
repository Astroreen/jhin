import * as Crypto from "node:crypto";

// Pairing codes follow T3 Code's pairing tokens (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/auth/PairingGrantStore.ts — twelve characters of an
// alphabet without look-alikes, valid five minutes, used once.

export const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;

/** One open pairing code; the code itself is never kept (security.md D419). */
interface PairingLink {
  readonly id: string;
  readonly label?: string;
  readonly permissions: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface Entry extends PairingLink {
  readonly codeHash: string;
}

const hash = (code: string) => Crypto.createHash("sha256").update(code).digest("base64url");

/** Uppercase, without the spaces and dashes people type between groups. */
export const normalizeCode = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase();

/**
 * Twelve characters of the alphabet, each from one random byte: 256 is a
 * multiple of the alphabet's 32 characters, so `byte % 32` is uniform.
 */
function newCode(): string {
  return [...Crypto.randomBytes(PAIRING_CODE_LENGTH)]
    .map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length])
    .join("");
}

export interface PairingStore {
  create(input: {
    label?: string;
    permissions: readonly string[];
    now: number;
    expiresAt: number;
  }): { link: PairingLink; code: string };
  /** Open codes at `now`, oldest first. */
  list(now: number): PairingLink[];
  revoke(id: string): boolean;
  /**
   * Runs `use` with the link a code opens and uses the code up only when
   * `use` returns: a failure leaves it valid. Undefined for a wrong, used or
   * expired code.
   */
  redeem<T>(code: string, now: number, use: (link: PairingLink) => T): T | undefined;
}

/** Open pairing codes, kept in memory: a restart ends them, as their five minutes would. */
export function createPairingStore(): PairingStore {
  let entries: Entry[] = [];
  const open = (now: number) => (entries = entries.filter((entry) => entry.expiresAt > now));
  const view = ({ codeHash: _code, ...link }: Entry): PairingLink => link;
  return {
    create({ label, permissions, now, expiresAt }) {
      const code = newCode();
      const entry: Entry = {
        id: Crypto.randomBytes(9).toString("base64url"),
        ...(label === undefined ? {} : { label }),
        permissions: [...permissions],
        createdAt: now,
        expiresAt,
        codeHash: hash(code),
      };
      entries = [...open(now), entry];
      return { link: view(entry), code };
    },
    list: (now) => open(now).map(view),
    revoke(id) {
      const before = entries.length;
      entries = entries.filter((entry) => entry.id !== id);
      return entries.length < before;
    },
    redeem(code, now, use) {
      const wanted = hash(normalizeCode(code));
      const entry = open(now).find((candidate) =>
        Crypto.timingSafeEqual(Buffer.from(candidate.codeHash), Buffer.from(wanted)),
      );
      if (entry === undefined) return undefined;
      // `use` is synchronous, so no second redeem runs in between.
      const result = use(view(entry));
      entries = entries.filter((candidate) => candidate !== entry);
      return result;
    },
  };
}
