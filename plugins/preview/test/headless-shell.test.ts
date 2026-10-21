// The cases follow T3 Code's apps/server/src/preview/PreviewBrowser.test.ts (MIT, see THIRD_PARTY_NOTICES.md).
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createHeadlessShell,
  headlessShellRelease,
  type HeadlessShellRelease,
} from "../src/headless-shell.ts";

/** A zip of stored entries, with unix modes, as Chrome for Testing's archives are. */
function zip(entries: readonly { name: string; data?: string; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const crc = Zlib.crc32(data);
    const directory = entry.name.endsWith("/");
    const mode = entry.mode ?? (directory ? 0o040755 : 0o100644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) Fs.rmSync(root, { recursive: true, force: true });
});

function setup(archive: Buffer, overrides: Partial<HeadlessShellRelease> = {}) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-shell-"));
  roots.push(root);
  const release: HeadlessShellRelease = {
    version: "1.0.0",
    platform: "linux64",
    url: "https://example.test/chrome-headless-shell-linux64.zip",
    bytes: archive.length,
    sha256: Crypto.createHash("sha256").update(archive).digest("hex"),
    ...overrides,
  };
  const requests: string[] = [];
  const shell = createHeadlessShell({
    root,
    platform: "linux",
    release,
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(new Uint8Array(archive), {
        headers: { "content-length": String(archive.length) },
      });
    },
  });
  return { root, shell, requests };
}

const GOOD = zip([
  { name: "chrome-headless-shell-linux64/" },
  {
    name: "chrome-headless-shell-linux64/chrome-headless-shell",
    data: "#!/bin/sh\n",
    mode: 0o100755,
  },
  { name: "chrome-headless-shell-linux64/libEGL.so", data: "lib" },
]);

describe("chrome-headless-shell on first use (D951)", () => {
  it("downloads, verifies and unpacks the pinned release once", async () => {
    const { root, shell, requests } = setup(GOOD);
    expect(shell.installed()).toBeUndefined();
    const executable = await shell.executable();
    expect(executable).toBe(Path.join(root, "linux64", "1.0.0", "chrome-headless-shell"));
    expect(Fs.statSync(executable).mode & 0o111).not.toBe(0);
    expect(Fs.readFileSync(Path.join(root, "linux64", "1.0.0", "libEGL.so"), "utf8")).toBe("lib");
    expect(await shell.executable()).toBe(executable);
    expect(requests).toHaveLength(1);
    // No staging left behind.
    expect(Fs.readdirSync(Path.join(root, "linux64"))).toEqual(["1.0.0"]);
  });

  it("refuses a download that fails its SHA-256 check, and installs nothing", async () => {
    const { root, shell } = setup(GOOD, { sha256: "0".repeat(64) });
    await expect(shell.executable()).rejects.toThrow("failed its size or SHA-256 check");
    expect(Fs.readdirSync(Path.join(root, "linux64"))).toEqual([]);
  });

  it("refuses a download of another size", async () => {
    const { shell } = setup(GOOD, { bytes: GOOD.length + 1 });
    await expect(shell.executable()).rejects.toThrow("size did not match");
  });

  it("refuses an archive with an entry outside its folder", async () => {
    const evil = zip([
      { name: "chrome-headless-shell-linux64/chrome-headless-shell", data: "x", mode: 0o100755 },
      { name: "chrome-headless-shell-linux64/../escape", data: "x" },
    ]);
    const { root, shell } = setup(evil);
    await expect(shell.executable()).rejects.toThrow(
      /unexpected or unsafe entry|could not be read/,
    );
    expect(Fs.existsSync(Path.join(root, "linux64", "escape"))).toBe(false);
  });

  it("refuses an archive without the shell", async () => {
    const { shell } = setup(zip([{ name: "chrome-headless-shell-linux64/README", data: "x" }]));
    await expect(shell.executable()).rejects.toThrow("does not contain chrome-headless-shell");
  });

  it("pins T3's release for each platform", () => {
    expect(headlessShellRelease("linux", "x64")).toMatchObject({
      platform: "linux64",
      version: "154.0.8037.92",
      url: "https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.92/linux64/chrome-headless-shell-linux64.zip",
    });
    expect(headlessShellRelease("win32", "arm64")?.platform).toBe("win64");
    expect(headlessShellRelease("freebsd", "x64")).toBeNull();
  });
});
