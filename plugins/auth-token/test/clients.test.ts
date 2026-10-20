import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createClientStore } from "../src/clients.ts";

const tempFile = () =>
  Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-clients-")), "clients.json");

describe("device token store (security.md D411)", () => {
  it("keeps only a hash of the secret, in a file only the owner reads", () => {
    const file = tempFile();
    const { record, token } = createClientStore(file).issue({
      label: "phone",
      permissions: ["threads.read"],
      method: "issued",
      now: 1000,
    });
    const secret = token.split(".")[2]!;
    const written = Fs.readFileSync(file, "utf8");
    expect(written).not.toContain(secret);
    expect(written).toContain(record.secretHash);
    expect(Fs.statSync(file).mode & 0o777).toBe(0o600);

    // A second store (a restarted node) reads the same tokens.
    expect(createClientStore(file).verify(token, 2000)?.id).toBe(record.id);
  });

  it("refuses a wrong secret, an unknown id and an expired token", () => {
    const store = createClientStore(tempFile());
    const { record, token } = store.issue({
      label: "laptop",
      permissions: ["*"],
      method: "pairing",
      now: 1000,
      expiresAt: 5000,
    });
    expect(store.verify(token, 4999)?.lastSeenAt).toBe(4999);
    expect(store.get(record.id)?.lastSeenAt).toBe(4999);
    expect(store.verify(token, 5000)).toBeUndefined();
    expect(store.verify(`${token}x`, 2000)).toBeUndefined();
    expect(store.verify(token.replace(record.id, "nobody"), 2000)).toBeUndefined();
    expect(
      store.verify("not-a-device-token-but-long-enough-to-look-like-one", 2000),
    ).toBeUndefined();
  });

  it("forgets removed tokens", () => {
    const store = createClientStore(tempFile());
    const { record, token } = store.issue({
      label: "x",
      permissions: ["*"],
      method: "issued",
      now: 1,
    });
    expect(store.remove([record.id, "unknown"]).map((gone) => gone.id)).toEqual([record.id]);
    expect(store.verify(token, 2)).toBeUndefined();
  });

  it("moves a file it cannot read aside instead of overwriting it, and accepts no token from it", () => {
    for (const content of ["{ truncated", '{ "clients": [{ "id": 1 }] }']) {
      const file = tempFile();
      Fs.writeFileSync(file, content);
      const reported: string[] = [];
      const store = createClientStore(file, (moved) => reported.push(moved));

      expect(reported).toEqual([`${file}.corrupt`]);
      expect(Fs.readFileSync(`${file}.corrupt`, "utf8")).toBe(content);
      expect(store.list()).toEqual([]);
      // A new token starts a new file; the old one stays where it was moved.
      store.issue({ label: "x", permissions: ["*"], method: "issued", now: 1 });
      expect(Fs.readFileSync(`${file}.corrupt`, "utf8")).toBe(content);
    }
  });

  it("drops expired tokens with the next write", () => {
    const file = tempFile();
    const store = createClientStore(file);
    const old = store.issue({
      label: "old",
      permissions: ["*"],
      method: "issued",
      now: 1,
      expiresAt: 10,
    });
    store.issue({ label: "new", permissions: ["*"], method: "issued", now: 20 });
    expect(store.get(old.record.id)).toBeUndefined();
    expect(
      createClientStore(file)
        .list()
        .map((record) => record.label),
    ).toEqual(["new"]);
  });

  it("changes nothing when a write fails, so a failed revoke leaves the token as it was", () => {
    const file = tempFile();
    const store = createClientStore(file);
    const { record, token } = store.issue({
      label: "x",
      permissions: ["*"],
      method: "issued",
      now: 1,
    });
    // A directory where the temporary file goes makes the next write fail.
    Fs.mkdirSync(`${file}.${process.pid}.tmp`);

    expect(() => store.remove([record.id])).toThrow();
    expect(store.get(record.id)?.id).toBe(record.id);
    expect(store.verify(token, 2)?.id).toBe(record.id);
    expect(() =>
      store.issue({ label: "y", permissions: ["*"], method: "issued", now: 3 }),
    ).toThrow();
    expect(store.list().map((entry) => entry.label)).toEqual(["x"]);
  });
});
