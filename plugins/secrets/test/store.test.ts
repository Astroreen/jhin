import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { SECRET_REF_TTL_MS, SecretsError } from "@jhin/secrets-api";
import { describe, expect, it } from "vite-plus/test";

import type { Keychain } from "../src/keychain.ts";
import { openStore } from "../src/store.ts";

const VALUE = "sk-live-4f1c2b9e-UNIQUE-SECRET";

const tempDir = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-secrets-"));

/** A keychain in memory; `broken` refuses to keep anything. */
function memoryKeychain(options: { broken?: boolean } = {}): Keychain & { key?: string } {
  const keychain: Keychain & { key?: string } = {
    kind: "libsecret",
    get: async () => keychain.key,
    set: async (key) => {
      if (options.broken === true) return false;
      keychain.key = key;
      return true;
    },
  };
  return keychain;
}

const place = { section: "acme.vault", path: ["env", "TOKEN"] };

describe("the secret store (security.md D1023)", () => {
  it("keeps values sealed in a 0600 file, with its key in a 0600 key file without a keychain", async () => {
    const dir = tempDir();
    const store = await openStore({ dir, keychain: undefined });
    const reference = store.putConfig(VALUE, place);
    expect(reference).toMatch(/^\$secret:[0-9a-f]{32}$/);
    expect(store.resolveConfig(reference, place)).toBe(VALUE);

    const file = Fs.readFileSync(Path.join(dir, "store.json"), "utf8");
    expect(file).not.toContain(VALUE);
    expect(file).not.toContain("acme.vault");
    expect(JSON.parse(file)).toMatchObject({ version: 1, key: "file" });
    expect(Fs.statSync(Path.join(dir, "store.json")).mode & 0o777).toBe(0o600);
    expect(Fs.statSync(Path.join(dir, "store.key")).mode & 0o777).toBe(0o600);
    expect(Fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(store.status()).toEqual({
      state: "ready",
      key: "file",
      keychain: null,
      configSecrets: 1,
      openRefs: 0,
    });

    const reopened = await openStore({ dir, keychain: undefined });
    expect(reopened.resolveConfig(reference, place)).toBe(VALUE);
  });

  it("puts a new store's key into the keychain, and leaves no key file", async () => {
    const dir = tempDir();
    const keychain = memoryKeychain();
    const store = await openStore({ dir, keychain });
    const reference = store.putConfig(VALUE, place);
    expect(Fs.existsSync(Path.join(dir, "store.key"))).toBe(false);
    expect(keychain.key).toBeDefined();
    expect(store.status()).toMatchObject({ key: "keychain", keychain: "libsecret" });
    expect((await openStore({ dir, keychain })).resolveConfig(reference, place)).toBe(VALUE);
  });

  it("falls back to the key file when the keychain does not keep the key", async () => {
    const dir = tempDir();
    const store = await openStore({ dir, keychain: memoryKeychain({ broken: true }) });
    expect(store.status().key).toBe("file");
    expect(Fs.existsSync(Path.join(dir, "store.key"))).toBe(true);
  });

  it("is unreadable without its key, overwrites nothing and never falls back to clear text", async () => {
    const dir = tempDir();
    const keychain = memoryKeychain();
    const first = await openStore({ dir, keychain });
    const reference = first.putConfig(VALUE, place);
    const sealed = Fs.readFileSync(Path.join(dir, "store.json"), "utf8");

    const store = await openStore({ dir, keychain: memoryKeychain() });
    expect(store.readable).toBe(false);
    expect(store.status().state).toBe("unreadable");
    expect(store.resolveConfig(reference, place)).toBeUndefined();
    expect(() => store.putConfig("other", place)).toThrow(SecretsError);
    expect(() => store.putRef("other", { projectId: "p", threadId: "t" })).toThrow(
      "The secret store could not be opened",
    );
    expect(Fs.readFileSync(Path.join(dir, "store.json"), "utf8")).toBe(sealed);
  });

  it("is unreadable when its file was tampered with or damaged", async () => {
    const dir = tempDir();
    const first = await openStore({ dir, keychain: undefined });
    first.putConfig(VALUE, place);
    const file = Path.join(dir, "store.json");
    const sealed = JSON.parse(Fs.readFileSync(file, "utf8"));
    const data = Buffer.from(sealed.data, "base64");
    data[0]! ^= 1;
    Fs.writeFileSync(file, JSON.stringify({ ...sealed, data: data.toString("base64") }));
    expect((await openStore({ dir, keychain: undefined })).readable).toBe(false);
    Fs.writeFileSync(file, "{ not json");
    expect((await openStore({ dir, keychain: undefined })).status().state).toBe("unreadable");
    expect(Fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("resolves a config reference only where it was made (D1025)", async () => {
    const store = await openStore({ dir: tempDir(), keychain: undefined });
    const reference = store.putConfig(VALUE, { section: "acme.vault", path: ["keys", 0] });
    // A list position does not count: a reordered list keeps its secrets.
    expect(store.resolveConfig(reference, { section: "acme.vault", path: ["keys", 3] })).toBe(
      VALUE,
    );
    expect(store.resolveConfig(reference, { section: "acme.vault", path: ["user"] })).toBe(
      undefined,
    );
    expect(store.resolveConfig(reference, { section: "acme.other", path: ["keys", 0] })).toBe(
      undefined,
    );
    store.deleteConfig(reference);
    expect(store.resolveConfig(reference, { section: "acme.vault", path: ["keys", 0] })).toBe(
      undefined,
    );
  });

  it("hands out a secretRef once, to its project only (D1030, D1031)", async () => {
    const store = await openStore({ dir: tempDir(), keychain: undefined });
    const ref = store.putRef(VALUE, { projectId: "p1", threadId: "t1" });
    expect(ref).toMatch(/^secret-ref:[0-9a-f]{32}$/);
    expect(store.hasRef(ref)).toBe(true);
    const error = (() => {
      try {
        store.consumeRef({ ref, projectId: "p2" });
      } catch (caught) {
        return caught as SecretsError;
      }
    })();
    expect(error?.code).toBe("SECRET_REF_UNAVAILABLE");
    expect(store.consumeRef({ ref, projectId: "p1" })).toBe(VALUE);
    expect(store.hasRef(ref)).toBe(false);
    expect(() => store.consumeRef({ ref, projectId: "p1" })).toThrow(
      "That secretRef was already used or does not exist.",
    );
    expect(() => store.consumeRef({ ref: "secret", projectId: "p1" })).toThrow(
      "That secretRef is not valid.",
    );
  });

  it("lets a secretRef expire after a day, and sweeps the expired ones", async () => {
    let now = 1_000_000;
    const dir = tempDir();
    const store = await openStore({ dir, keychain: undefined, now: () => now });
    const old = store.putRef(VALUE, { projectId: "p", threadId: "t" });
    now += SECRET_REF_TTL_MS + 1;
    expect(() => store.consumeRef({ ref: old, projectId: "p" })).toThrow("That secretRef expired.");
    expect(store.hasRef(old)).toBe(false);

    const stale = store.putRef(VALUE, { projectId: "p", threadId: "t" });
    now += SECRET_REF_TTL_MS + 1;
    const fresh = store.putRef(VALUE, { projectId: "p", threadId: "t" });
    expect(store.sweep()).toBe(1);
    expect(store.hasRef(stale)).toBe(false);
    expect(store.hasRef(fresh)).toBe(true);
  });
});
