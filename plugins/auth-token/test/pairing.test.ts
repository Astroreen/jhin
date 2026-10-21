import { describe, expect, it } from "vite-plus/test";

import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  createPairingStore,
  normalizeCode,
} from "../src/pairing.ts";

describe("pairing codes (security.md D419)", () => {
  it("are twelve characters of T3's alphabet", () => {
    const { code } = createPairingStore().create({ permissions: ["*"], now: 0, expiresAt: 10 });
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect([...code].every((char) => PAIRING_ALPHABET.includes(char))).toBe(true);
  });

  it("open their link once, as typed by a person, until they expire", () => {
    const store = createPairingStore();
    const { link, code } = store.create({
      label: "iPad",
      permissions: ["threads.*"],
      now: 0,
      expiresAt: 300_000,
    });
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4, 8)} ${code.slice(8)}`;
    expect(normalizeCode(typed)).toBe(code);
    expect(store.redeem(typed, 1, (link) => link)).toEqual(link);
    expect(store.redeem(code, 2, (link) => link)).toBeUndefined();

    const late = store.create({ permissions: ["*"], now: 0, expiresAt: 100 });
    expect(store.list(50).map((entry) => entry.id)).toEqual([late.link.id]);
    expect(store.redeem(late.code, 100, (link) => link)).toBeUndefined();
    expect(store.list(100)).toEqual([]);
  });

  it("never lists or keeps the code itself, and can be revoked", () => {
    const store = createPairingStore();
    const { link, code } = store.create({ permissions: ["*"], now: 0, expiresAt: 10 });
    expect(JSON.stringify(store.list(1))).not.toContain(code);
    expect(store.revoke(link.id)).toBe(true);
    expect(store.redeem(code, 1, (link) => link)).toBeUndefined();
  });

  it("keeps a code valid when using it fails", () => {
    const store = createPairingStore();
    const { code } = store.create({ permissions: ["*"], now: 0, expiresAt: 10 });
    expect(() =>
      store.redeem(code, 1, () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(store.redeem(code, 2, (link) => link.permissions)).toEqual(["*"]);
    expect(store.redeem(code, 3, () => "again")).toBeUndefined();
  });
});
