import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { AUTH_VERIFIER_CAPABILITY, AuthEvents, type AuthVerifier } from "@jhin/auth-api";
import { definePlugin, type Logger, type PluginContext } from "@jhin/sdk";
import { createTestKernel, mockCapability, testManifest } from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createClientStore, type ClientRepair } from "../src/clients.ts";
import auth from "../src/index.ts";

const authManifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

afterEach(() => {
  vi.useRealTimers();
});

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

  it("keeps a file it cannot read beside the repaired one, and accepts no token it cannot read", () => {
    // Text with no record in it, and a JSON list whose one record does not read.
    for (const [content, unreadable] of [
      ["{ truncated", 0],
      ['{ "clients": [{ "id": 1 }] }', 1],
    ] as const) {
      const file = tempFile();
      Fs.writeFileSync(file, content);
      const reported: ClientRepair[] = [];
      const store = createClientStore(
        file,
        (repair) => reported.push(repair),
        () => NOW,
      );

      const moved = `${file}.corrupt-2026-10-24T12-00-00-000Z`;
      expect(reported).toEqual([
        { moved, error: expect.any(String), kept: 0, unreadable, expired: 0 },
      ]);
      expect(Fs.readFileSync(moved, "utf8")).toBe(content);
      expect(Fs.statSync(moved).mode & 0o777).toBe(0o600);
      expect(store.list()).toEqual([]);
      // A new token goes to the repaired file; the unreadable one stays where it was kept.
      store.issue({ label: "x", permissions: ["*"], method: "issued", now: 1 });
      expect(Fs.readFileSync(moved, "utf8")).toBe(content);
    }
  });

  it("writes when a device was last seen at most hourly and on flush, and tells the list at most once a minute (security.md D1708)", () => {
    const file = tempFile();
    const seen: unknown[] = [];
    const store = createClientStore(
      file,
      undefined,
      () => 0,
      (error) => seen.push(error),
    );
    const { record, token } = store.issue({
      label: "phone",
      permissions: ["*"],
      method: "issued",
      now: 0,
    });
    const inFile = () => createClientStore(file).get(record.id)?.lastSeenAt;
    const MINUTE = 60_000;

    // The first sighting is written and told.
    store.verify(token, MINUTE);
    expect(inFile()).toBe(MINUTE);
    expect(seen).toEqual([undefined]);
    // Seen again within the minute: neither.
    store.verify(token, MINUTE + 30_000);
    expect(seen).toHaveLength(1);
    expect(inFile()).toBe(MINUTE);
    // A minute after the last telling: told, not yet written.
    store.verify(token, 2 * MINUTE);
    expect(seen).toHaveLength(2);
    expect(store.get(record.id)?.lastSeenAt).toBe(2 * MINUTE);
    expect(inFile()).toBe(MINUTE);
    // An hour after the one in the file: written.
    store.verify(token, 61 * MINUTE);
    expect(inFile()).toBe(61 * MINUTE);
    // Stopping writes the latest one.
    store.verify(token, 62 * MINUTE);
    expect(inFile()).toBe(61 * MINUTE);
    store.flush();
    expect(inFile()).toBe(62 * MINUTE);
  });

  it("never fails a sighting on the disk; it tells the failure instead (security.md D1708)", () => {
    const file = tempFile();
    const seen: unknown[] = [];
    const store = createClientStore(
      file,
      undefined,
      () => 0,
      (error) => seen.push(error),
    );
    const { token } = store.issue({ label: "phone", permissions: ["*"], method: "issued", now: 0 });
    // A directory where the temporary file goes: every write fails.
    Fs.mkdirSync(`${file}.${process.pid}.tmp`);
    expect(store.verify(token, 1000)).toMatchObject({ lastSeenAt: 1000 });
    expect(seen[0]).toBeInstanceOf(Error);
    const failures = () => seen.filter((item) => item instanceof Error);
    // Not tried again on every sighting: an hour later.
    store.verify(token, 2000);
    expect(failures()).toHaveLength(1);
    store.verify(token, 1000 + 60 * 60_000);
    expect(failures()).toHaveLength(2);
    // Stopping tries once more.
    store.flush();
    expect(failures()).toHaveLength(3);
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

const NOW = Date.UTC(2026, 9, 24, 12);

/** Three tokens in a file of their own; returns the file's text and the tokens. */
function threeTokens() {
  const file = tempFile();
  const store = createClientStore(file);
  const issue = (label: string, expiresAt?: number) =>
    store.issue({
      label,
      permissions: ["threads.read"],
      method: "pairing",
      now: NOW - 1000,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      metadata: { deviceType: "mobile", os: "iOS" },
    });
  const phone = issue("phone");
  const laptop = issue("laptop", NOW + 60_000);
  const old = issue("old", NOW - 1);
  return { file, text: Fs.readFileSync(file, "utf8"), phone, laptop, old };
}

describe("repairing an unreadable clients.json from itself (security.md D1518)", () => {
  it("keeps the records of a JSON file that still read on their own, and drops the expired", () => {
    const { file, text, phone, laptop, old } = threeTokens();
    const parsed = JSON.parse(text) as { clients: Record<string, unknown>[] };
    // One record broken: the whole file no longer reads.
    parsed.clients[1] = { ...parsed.clients[1], permissions: "threads.read" };
    const broken = JSON.stringify(parsed);
    Fs.writeFileSync(file, broken);

    const reported: ClientRepair[] = [];
    const store = createClientStore(
      file,
      (repair) => reported.push(repair),
      () => NOW,
    );
    expect(reported).toEqual([
      {
        moved: `${file}.corrupt-2026-10-24T12-00-00-000Z`,
        error: expect.any(String),
        kept: 1,
        unreadable: 1,
        expired: 1,
      },
    ]);
    expect(store.verify(phone.token, NOW)?.id).toBe(phone.record.id);
    expect(store.verify(laptop.token, NOW)).toBeUndefined();
    expect(store.verify(old.token, NOW)).toBeUndefined();
    // Written whole, 0600, and read again as it is, without another repair.
    expect(Fs.statSync(file).mode & 0o777).toBe(0o600);
    const again: ClientRepair[] = [];
    expect(
      createClientStore(
        file,
        (repair) => again.push(repair),
        () => NOW,
      )
        .list()
        .map((record) => record.label),
    ).toEqual(["phone"]);
    expect(again).toEqual([]);
    expect(Fs.readFileSync(reported[0]!.moved!, "utf8")).toBe(broken);
  });

  it("finds the records in text that is not JSON any more", () => {
    const { file, text, phone, laptop } = threeTokens();
    // Truncated in the middle of the last record, with junk before it.
    const broken = `\u0000garbage ${text.slice(0, text.lastIndexOf('"secretHash"') + 20)}`;
    Fs.writeFileSync(file, broken);

    const reported: ClientRepair[] = [];
    const store = createClientStore(
      file,
      (repair) => reported.push(repair),
      () => NOW,
    );
    expect(reported).toMatchObject([{ kept: 2, unreadable: 1, expired: 0 }]);
    expect(store.verify(phone.token, NOW)?.id).toBe(phone.record.id);
    expect(store.verify(laptop.token, NOW)?.id).toBe(laptop.record.id);
    expect(store.get(phone.record.id)?.metadata).toEqual({ deviceType: "mobile", os: "iOS" });
  });

  it("never overwrites an earlier unreadable file, and reads no older copy", () => {
    const { file, text, phone } = threeTokens();
    // A copy an earlier repair kept still holds every token; it is never read.
    const earlier = `${file}.corrupt-2026-10-24T12-00-00-000Z`;
    Fs.writeFileSync(earlier, text);
    Fs.writeFileSync(file, "{ nothing left");

    const reported: ClientRepair[] = [];
    const store = createClientStore(
      file,
      (repair) => reported.push(repair),
      () => NOW,
    );
    expect(reported).toMatchObject([{ moved: `${earlier}-1`, kept: 0, unreadable: 0 }]);
    expect(Fs.readFileSync(earlier, "utf8")).toBe(text);
    expect(Fs.readFileSync(`${earlier}-1`, "utf8")).toBe("{ nothing left");
    expect(store.verify(phone.token, NOW)).toBeUndefined();
    expect(JSON.parse(Fs.readFileSync(file, "utf8"))).toEqual({ clients: [] });
  });

  it("never stops the node when the repair cannot be written: nothing is accepted, the file moved aside", () => {
    const { file, text, phone } = threeTokens();
    Fs.writeFileSync(file, text.slice(0, -40));
    // The new file's temporary name is taken by a directory: the write fails.
    Fs.mkdirSync(`${file}.${process.pid}.tmp`);

    const reported: ClientRepair[] = [];
    const store = createClientStore(
      file,
      (repair) => reported.push(repair),
      () => NOW,
    );
    const moved = `${file}.corrupt-2026-10-24T12-00-00-000Z`;
    expect(reported).toEqual([
      {
        moved,
        error: expect.any(String),
        kept: 0,
        unreadable: 1,
        expired: 0,
        failed: expect.stringContaining("EISDIR"),
      },
    ]);
    expect(store.list()).toEqual([]);
    expect(store.verify(phone.token, NOW)).toBeUndefined();
    expect(Fs.existsSync(file)).toBe(false);
    expect(Fs.readFileSync(moved, "utf8")).toBe(text.slice(0, -40));
  });

  it("counts the records that start as the node writes them but did not read", () => {
    const { file, text } = threeTokens();
    // A label that looks like a record is escaped in the file and never counts;
    // a record cut off before its end does.
    const store = createClientStore(file);
    store.issue({
      label: '{"id": "fake", "secretHash": "x"}',
      permissions: ["*"],
      method: "issued",
      now: NOW - 1000,
    });
    const withLabel = Fs.readFileSync(file, "utf8");
    expect(withLabel.length).toBeGreaterThan(text.length);
    Fs.writeFileSync(file, withLabel.slice(0, -40));

    const reported: ClientRepair[] = [];
    createClientStore(
      file,
      (repair) => reported.push(repair),
      () => NOW,
    );
    expect(reported).toMatchObject([{ kept: 2, unreadable: 1, expired: 1 }]);
  });

  it("tells the clients list of a sighting and writes the last one when it stops (security.md D1708)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-clients-plugin-"));
    let probe: PluginContext | undefined;
    const kernel = await createTestKernel({
      plugins: [
        mockCapability("host.paths", {
          home: data,
          dataDir: (id: string) => {
            Fs.mkdirSync(Path.join(data, id), { recursive: true });
            return Path.join(data, id);
          },
        }),
        { manifest: authManifest, definition: auth },
        {
          manifest: testManifest("app.probe", { requires: { "auth.verifier": "^1.0.0" } }),
          definition: definePlugin({
            activate(context) {
              probe = context;
            },
          }),
        },
      ],
    });
    try {
      const told: unknown[] = [];
      kernel.events.on(AuthEvents.clientsChanged, (payload) => told.push(payload));
      const { id, token } = (await kernel.commands.execute("auth.tokens.issue", {
        label: "phone",
        permissions: ["app.read"],
      })) as { id: string; token: string };
      const verifier = probe!.services.get<AuthVerifier>(AUTH_VERIFIER_CAPABILITY);
      const inFile = () =>
        (
          JSON.parse(
            Fs.readFileSync(Path.join(data, "jhin.auth-token", "clients.json"), "utf8"),
          ) as { clients: { id: string; lastSeenAt?: number }[] }
        ).clients.find((client) => client.id === id)?.lastSeenAt;

      const issuedTold = told.length;
      const first = Date.now();
      await verifier.verify({ token });
      expect(told).toHaveLength(issuedTold + 1);
      expect(inFile()).toBe(first);
      vi.setSystemTime(first + 5 * 60_000);
      await verifier.verify({ token });
      expect(told).toHaveLength(issuedTold + 2);
      expect(inFile()).toBe(first);
    } finally {
      await kernel.stop();
    }
    expect(
      (
        JSON.parse(Fs.readFileSync(Path.join(data, "jhin.auth-token", "clients.json"), "utf8")) as {
          clients: { lastSeenAt?: number }[];
        }
      ).clients[0]?.lastSeenAt,
    ).toBe(Date.now());
  });

  it("keeps the node starting when clients.json cannot be repaired", async () => {
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-clients-plugin-"));
    const dir = Path.join(data, "jhin.auth-token");
    Fs.mkdirSync(dir, { recursive: true });
    const file = Path.join(dir, "clients.json");
    Fs.writeFileSync(file, '{ "clients": [{ "id": 1 }');
    Fs.mkdirSync(`${file}.${process.pid}.tmp`);
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (message) => void warnings.push(message),
      error() {},
      child: () => logger,
    };
    const kernel = await createTestKernel({
      logger,
      plugins: [
        mockCapability("host.paths", {
          home: data,
          dataDir: (id: string) => Path.join(data, id),
        }),
        { manifest: authManifest, definition: auth },
      ],
    });
    try {
      expect(kernel.inspect().plugins.filter((plugin) => plugin.status !== "active")).toEqual([]);
      expect(warnings).toContain(
        "device tokens unreadable and the repair could not be written; none are accepted until they are issued again",
      );
      expect(Fs.existsSync(file)).toBe(false);
    } finally {
      await kernel.stop();
    }
  });
});
