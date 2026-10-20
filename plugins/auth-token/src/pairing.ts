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

/** Twelve characters of the alphabet, by rejection sampling so each is equally likely. */
function newCode(): string {
  let code = "";
  // 256 is a multiple of the alphabet's 32 characters, so every byte maps evenly.
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of Crypto.randomBytes(PAIRING_CODE_LENGTH)) {
      if (code.length < PAIRING_CODE_LENGTH) code += PAIRING_ALPHABET[byte % 32];
    }
  }
  return code;
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
  /** The link a code opens, used up by this call; undefined for a wrong, used or expired code. */
  consume(code: string, now: number): PairingLink | undefined;
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
    consume(code, now) {
      const wanted = hash(normalizeCode(code));
      const entry = open(now).find((candidate) =>
        Crypto.timingSafeEqual(Buffer.from(candidate.codeHash), Buffer.from(wanted)),
      );
      if (entry === undefined) return undefined;
      entries = entries.filter((candidate) => candidate !== entry);
      return view(entry);
    },
  };
}
