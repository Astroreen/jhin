// Ported from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/desktop/src/preview/BrowserImport/ChromiumCookies.test.ts and ChromiumKeys.test.ts.
// docs/plans/preview.md, D1204.
import * as Crypto from "node:crypto";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  decryptChromiumValue,
  readChromiumCookieDatabase,
  readChromiumCookies,
} from "../src/browser-import/chromium-cookies.ts";
import {
  ChromiumKeyError,
  decodeWindowsWrappedKey,
  readLinuxSecret,
  resolveChromiumKeys,
  unwrapWindowsDpapiKey,
} from "../src/browser-import/chromium-keys.ts";
import { cookieScope } from "../src/browser-import/cookie-database.ts";
import {
  encryptChromium,
  encryptWindowsV10,
  fakeHost,
  ran,
  tempDirectory,
  writeChromiumCookieDatabase,
  type ChromiumRow,
} from "./browser-import-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function database(rows: ReadonlyArray<ChromiumRow>, version?: number | string): string {
  const directory = tempDirectory("jhin-chromium-cookies-");
  cleanups.push(directory.remove);
  return writeChromiumCookieDatabase(Path.join(directory.path, "Cookies"), rows, version);
}

const key = Buffer.from("0123456789abcdef");
const encryptV10 = (value: string | Buffer, with_ = key) => encryptChromium("v10", value, with_);
const boundValue = (host: string, value: string) =>
  Buffer.concat([Crypto.createHash("sha256").update(host).digest(), Buffer.from(value)]);
const names = (result: { cookies: ReadonlyArray<{ name: string; value: string }> }) =>
  result.cookies.map(({ name, value }) => ({ name, value }));

describe("cookieScope", () => {
  it("keeps a host-only cookie host-only", () => {
    // Chromium stores a host-only cookie without a leading dot; a domain would
    // expose it to every subdomain it was never scoped to.
    expect(cookieScope("example.test", "/", true)).toEqual({
      url: "https://example.test/",
      domain: undefined,
    });
  });

  it("preserves a domain cookie's leading dot", () => {
    expect(cookieScope(".example.test", "/app", true)).toEqual({
      url: "https://example.test/app",
      domain: ".example.test",
    });
  });

  it("matches the scheme to the secure flag", () => {
    expect(cookieScope("example.test", "/", false).url).toBe("http://example.test/");
  });

  it("brackets bare IPv6 hosts without duplicating existing brackets", () => {
    expect(cookieScope("::1", "/", false)).toEqual({ url: "http://[::1]/", domain: undefined });
    expect(cookieScope("[::1]", "/app", true)).toEqual({
      url: "https://[::1]/app",
      domain: undefined,
    });
  });
});

describe("readChromiumCookieDatabase", () => {
  it("decrypts Windows v10 AES-GCM records and rejects app-bound v20 records", () => {
    const windowsKey = Buffer.from("0123456789abcdef0123456789abcdef");
    const host = ".example.test";
    const bound = boundValue(host, "windows value");
    expect(
      decryptChromiumValue(
        encryptWindowsV10(bound, windowsKey),
        { gcmV10: windowsKey },
        host,
        24,
        "win32",
      ),
    ).toBe("windows value");
    expect(
      decryptChromiumValue(Buffer.from("v20app-bound"), { gcmV10: windowsKey }, host, 24, "win32"),
    ).toBeNull();
    expect(
      decryptChromiumValue(
        encryptWindowsV10(bound, Buffer.alloc(32, 1)),
        { gcmV10: windowsKey },
        host,
        24,
        "win32",
      ),
    ).toBeNull();
  });

  it("reports the missing key when no cookies can be read, while keeping partial imports", async () => {
    const v11 = {
      host_key: "v11.example",
      name: "session",
      encrypted_value: encryptChromium("v11", "secret", key),
      is_secure: 1,
      is_httponly: 1,
      samesite: 1,
    };
    // No `secret-tool` on this machine: the keyring is unavailable, v10 still reads.
    const host = fakeHost({ home: "/nonexistent" });
    await expect(
      readChromiumCookies(host, {
        cookieDatabasePath: database([v11]),
        linuxSecretApplication: "chromium",
        keychainService: undefined,
        keychainAccount: undefined,
      }),
    ).rejects.toMatchObject({ reason: "keychainUnavailable" });

    const keys = { cbcV10: key, cbcV11Error: new ChromiumKeyError("keychainUnavailable") };
    const partial = readChromiumCookieDatabase(
      database([
        v11,
        { ...v11, host_key: "v10.example", name: "readable", encrypted_value: encryptV10("kept") },
      ]),
      keys,
      "linux",
    );
    expect(partial.cookies.map((cookie) => cookie.value)).toEqual(["kept"]);
    expect(partial.undecryptable).toBe(1);

    const partitioned = readChromiumCookieDatabase(
      database([{ ...v11, top_frame_site_key: "https://top.example" }]),
      keys,
      "linux",
    );
    expect(partitioned.cookies).toEqual([]);
    expect(partitioned.undecryptable).toBe(1);
  });

  it("reads plaintext, encrypted and genuinely empty cookie values", () => {
    const result = readChromiumCookieDatabase(
      database([
        { host_key: "plain.example", name: "plain", value: "stored plaintext" },
        {
          host_key: "secure.example",
          name: "encrypted",
          encrypted_value: encryptV10("stored encrypted"),
          is_secure: 1,
          is_httponly: 1,
          samesite: 2,
        },
        { host_key: "empty.example", name: "empty", samesite: 0 },
      ]),
      { cbcV10: key },
      "darwin",
    );
    expect(result.undecryptable).toBe(0);
    expect(names(result)).toEqual([
      { name: "plain", value: "stored plaintext" },
      { name: "encrypted", value: "stored encrypted" },
      { name: "empty", value: "" },
    ]);
    expect(result.cookies.map((cookie) => cookie.sameSite)).toEqual([
      "unspecified",
      "strict",
      "no_restriction",
    ]);
  });

  it("converts Chromium's microsecond expiry from 1601 into UNIX seconds", () => {
    const unix = 1_800_000_000;
    const result = readChromiumCookieDatabase(
      database([
        {
          host_key: ".example.test",
          name: "kept",
          value: "v",
          expires_utc: BigInt(unix + 11_644_473_600) * 1_000_000n,
        },
        { host_key: "example.test", name: "session", value: "v" },
      ]),
      { cbcV10: key },
      "linux",
    );
    expect(result.cookies.map((cookie) => cookie.expirationDate)).toEqual([unix, undefined]);
    expect(result.cookies.map((cookie) => cookie.domain)).toEqual([".example.test", undefined]);
  });

  it("enforces domain binding only for schema 24 and newer", () => {
    const result = readChromiumCookieDatabase(
      database(
        [
          {
            host_key: "bound.example",
            name: "valid",
            encrypted_value: encryptV10(boundValue("bound.example", "kept")),
          },
          {
            host_key: "wrong.example",
            name: "mismatch",
            encrypted_value: encryptV10(boundValue("another.example", "drop")),
          },
          { host_key: "short.example", name: "short", encrypted_value: encryptV10("short value") },
        ],
        24,
      ),
      { cbcV10: key },
      "darwin",
    );
    expect(names(result)).toEqual([{ name: "valid", value: "kept" }]);
    expect(result.undecryptable).toBe(2);
    expect(result.undecryptableHosts).toEqual(["wrong.example", "short.example"]);
  });

  it("decrypts mixed v10 and v11 cookies with their respective keys", () => {
    const cbcV11 = Buffer.from("fedcba9876543210");
    const file = database(
      [
        {
          host_key: "v10.example",
          name: "v10-cookie",
          encrypted_value: encryptV10(boundValue("v10.example", "v10 value")),
        },
        {
          host_key: "v11.example",
          name: "v11-cookie",
          encrypted_value: encryptChromium("v11", boundValue("v11.example", "v11 value"), cbcV11),
        },
      ],
      "24",
    );
    const complete = readChromiumCookieDatabase(file, { cbcV10: key, cbcV11 }, "linux");
    expect(names(complete)).toEqual([
      { name: "v10-cookie", value: "v10 value" },
      { name: "v11-cookie", value: "v11 value" },
    ]);
    expect(complete.undecryptable).toBe(0);
    const v10Only = readChromiumCookieDatabase(file, { cbcV10: key }, "linux");
    expect(names(v10Only)).toEqual([{ name: "v10-cookie", value: "v10 value" }]);
    expect(v10Only.undecryptableHosts).toEqual(["v11.example"]);
  });

  it("recovers records written with the empty-passphrase key", () => {
    const cbcV11 = Buffer.from("fedcba9876543210");
    // The key some Linux clients encrypted with (crbug.com/1195256).
    const cbcEmpty = Crypto.pbkdf2Sync("", "saltysalt", 1, 16, "sha1");
    const file = database([
      {
        host_key: "ev10.example",
        name: "empty-v10",
        encrypted_value: encryptChromium("v10", "empty v10 value", cbcEmpty),
      },
      {
        host_key: "ev11.example",
        name: "empty-v11",
        encrypted_value: encryptChromium("v11", "empty v11 value", cbcEmpty),
      },
    ]);
    const recovered = readChromiumCookieDatabase(file, { cbcV10: key, cbcV11, cbcEmpty }, "linux");
    expect(names(recovered)).toEqual([
      { name: "empty-v10", value: "empty v10 value" },
      { name: "empty-v11", value: "empty v11 value" },
    ]);
    const noV11 = readChromiumCookieDatabase(file, { cbcV10: key, cbcEmpty }, "linux");
    expect(noV11.cookies.map(({ name }) => name)).toEqual(["empty-v10"]);
    expect(noV11.undecryptableHosts).toEqual(["ev11.example"]);
  });

  it("preserves arbitrary long encrypted values from pre-24 schemas", () => {
    const value = `${"x".repeat(32)} legacy value`;
    const result = readChromiumCookieDatabase(
      database([
        { host_key: "legacy.example", name: "legacy", encrypted_value: encryptV10(value) },
      ]),
      { cbcV10: key },
      "darwin",
    );
    expect(result.cookies[0]?.value).toBe(value);
  });

  it("rejects a malformed text schema version", () => {
    expect(() =>
      readChromiumCookieDatabase(database([], "not-a-version"), { cbcV10: key }, "darwin"),
    ).toThrow(/schema version/);
  });

  it("treats unversioned encrypted values as legacy plaintext on macOS and Linux", () => {
    // OSCrypt returns unprefixed data as is ("old data saved as clear text").
    const file = database([
      {
        host_key: "legacy.example",
        name: "legacy",
        encrypted_value: Buffer.from("legacy cleartext"),
      },
    ]);
    for (const platform of ["darwin", "linux"] as const) {
      const result = readChromiumCookieDatabase(file, { cbcV10: key }, platform);
      expect(result.cookies[0]?.value).toBe("legacy cleartext");
      expect(result.undecryptable).toBe(0);
    }
  });

  it("skips partitioned cookies without breaking pre-CHIPS schemas", () => {
    const legacy = readChromiumCookieDatabase(
      database([{ host_key: "legacy.example", name: "legacy", value: "kept" }], 14),
      { cbcV10: key },
      "darwin",
    );
    const chips = readChromiumCookieDatabase(
      database([
        { host_key: "plain.example", name: "plain", value: "kept" },
        {
          host_key: "partitioned.example",
          name: "partitioned",
          value: "must skip",
          is_secure: 1,
          top_frame_site_key: "https://top.example",
        },
      ]),
      { cbcV10: key },
      "darwin",
    );
    expect(legacy.cookies.map(({ name }) => name)).toEqual(["legacy"]);
    expect(chips.cookies.map(({ name }) => name)).toEqual(["plain"]);
    expect(chips.undecryptableHosts).toEqual(["partitioned.example"]);
  });
});

describe("macOS Chromium secrets", () => {
  const request = {
    platform: "darwin" as const,
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    linuxSecretApplication: "chrome",
  };

  it("derives the cookie key from the keychain secret through `security`", async () => {
    const host = fakeHost({
      platform: "darwin",
      home: "/Users/u",
      run: () => ran(0, "macos-secret\n"),
    });
    const keys = await resolveChromiumKeys(host, request);
    expect(keys.cbcV10?.toString("hex")).toBe("3df7306fb1eac353289565a2f6b64f74");
    expect(host.calls[0]).toMatchObject({
      command: "/usr/bin/security",
      args: ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    });
  });

  it("reports a missing keychain entry", async () => {
    const host = fakeHost({ platform: "darwin", home: "/Users/u", run: () => ran(44) });
    await expect(resolveChromiumKeys(host, request)).rejects.toMatchObject({
      reason: "keychainItemMissing",
    });
  });

  it("reports a denied keychain approval", async () => {
    const host = fakeHost({ platform: "darwin", home: "/Users/u", run: () => ran(51) });
    await expect(resolveChromiumKeys(host, request)).rejects.toMatchObject({
      reason: "needsKeychainApproval",
    });
  });
});

describe("Linux Chromium secrets", () => {
  const request = {
    platform: "linux" as const,
    keychainService: undefined,
    keychainAccount: undefined,
    linuxSecretApplication: "msedge",
  };

  it("keeps the v10 fallback and the keyring failure when `secret-tool` is missing", async () => {
    const keys = await resolveChromiumKeys(fakeHost({ home: "/home/u" }), request);
    expect(keys.cbcV10).toHaveLength(16);
    expect(keys.cbcV11).toBeUndefined();
    expect(keys.cbcV11Error?.reason).toBe("keychainUnavailable");
  });

  it("looks up the browser's libsecret application attribute", async () => {
    const host = fakeHost({ home: "/home/u", run: () => ran(0, "linux-secret") });
    const keys = await resolveChromiumKeys(host, request);
    expect(host.calls).toMatchObject([
      { command: "secret-tool", args: ["lookup", "application", "msedge"], stdin: undefined },
    ]);
    expect(keys.cbcV10).toHaveLength(16);
    expect(keys.cbcV11).toEqual(Crypto.pbkdf2Sync("linux-secret", "saltysalt", 1, 16, "sha1"));
  });

  it("preserves trailing whitespace in the stored secret", async () => {
    const host = fakeHost({ home: "/home/u", run: () => ran(0, "linux-secret \t\n") });
    expect(await readLinuxSecret(host, "chrome")).toBe("linux-secret \t\n");
  });

  it("tells a missing key from an unavailable backend and a refused unlock", async () => {
    const answer = async (result: ReturnType<typeof ran>) =>
      readLinuxSecret(fakeHost({ home: "/home/u", run: () => result }), "chrome").catch(
        (error: ChromiumKeyError) => error.reason,
      );
    expect(await answer(ran(1))).toBe("keychainItemMissing");
    expect(await answer(ran(0, ""))).toBe("keychainItemMissing");
    expect(
      await answer(ran(1, "", "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY")),
    ).toBe("keychainUnavailable");
    expect(await answer(ran(1, "", "secret-tool: Cancelled by user"))).toBe(
      "needsKeychainApproval",
    );
  });

  it("does not discard a refused unlock while resolving keys", async () => {
    const host = fakeHost({ home: "/home/u", run: () => ran(1, "", "Collection is locked") });
    await expect(resolveChromiumKeys(host, request)).rejects.toMatchObject({
      reason: "needsKeychainApproval",
    });
  });

  it("keeps the v10 fallback when no matching v11 secret exists", async () => {
    const keys = await resolveChromiumKeys(
      fakeHost({ home: "/home/u", run: () => ran(1) }),
      request,
    );
    expect(keys.cbcV10).toEqual(Crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"));
    expect(keys.cbcV11).toBeUndefined();
    expect(keys.cbcV11Error?.reason).toBe("keychainItemMissing");
  });
});

describe("an unanswered Keychain or keyring prompt", () => {
  const aborted = () => {
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  };

  it("is bounded, and its end is a consent failure on macOS and Linux", async () => {
    const mac = fakeHost({ platform: "darwin", home: "/Users/u", run: aborted });
    await expect(
      resolveChromiumKeys(mac, {
        platform: "darwin",
        keychainService: "Chrome Safe Storage",
        keychainAccount: "Chrome",
        linuxSecretApplication: undefined,
      }),
    ).rejects.toMatchObject({ reason: "needsKeychainApproval" });
    expect(mac.calls[0]?.signal).toBeInstanceOf(AbortSignal);

    const linux = fakeHost({ home: "/home/u", run: aborted });
    await expect(
      resolveChromiumKeys(linux, {
        platform: "linux",
        keychainService: undefined,
        keychainAccount: undefined,
        linuxSecretApplication: "chrome",
      }),
    ).rejects.toMatchObject({ reason: "needsKeychainApproval" });
    expect(linux.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("Windows Chromium secrets", () => {
  it("accepts only DPAPI-wrapped non-app-bound keys", () => {
    const wrapped = Buffer.from("wrapped-key");
    const encoded = Buffer.concat([Buffer.from("DPAPI"), wrapped]).toString("base64");
    expect(decodeWindowsWrappedKey(`{"os_crypt":{"encrypted_key":"${encoded}"}}`)).toEqual(wrapped);
    expect(() =>
      decodeWindowsWrappedKey(
        `{"os_crypt":{"encrypted_key":"${encoded}","app_bound_encrypted_key":"present"}}`,
      ),
    ).toThrow(expect.objectContaining({ reason: "unsupportedPlatform" }));
    expect(() =>
      decodeWindowsWrappedKey(`{"os_crypt":{"encrypted_key":"${wrapped.toString("base64")}"}}`),
    ).toThrow(expect.objectContaining({ reason: "readFailed" }));
  });

  it("unwraps the binary key through PowerShell without placing it in argv", async () => {
    const wrapped = Buffer.from("wrapped-key");
    const windowsKey = Buffer.from("0123456789abcdef0123456789abcdef");
    const host = fakeHost({
      platform: "win32",
      home: "C:\\Users\\u",
      env: { SystemRoot: "C:\\Windows" },
      run: () => ran(0, windowsKey.toString("base64")),
    });
    expect(await unwrapWindowsDpapiKey(host, wrapped)).toEqual(windowsKey);
    const call = host.calls[0];
    expect(call?.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(call?.args).toContain("-NonInteractive");
    expect(call?.args.join(" ")).not.toContain(wrapped.toString("base64"));
    expect(call?.stdin).toBe(wrapped.toString("base64"));
  });
});
