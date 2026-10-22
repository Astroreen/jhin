// The cases follow T3 Code's scripts/merge-update-manifests.test.ts (MIT, see THIRD_PARTY_NOTICES.md).
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  mergePlatformUpdateManifests,
  mergeUpdateManifestFiles,
  parsePlatformUpdateManifest,
  serializePlatformUpdateManifest,
} from "./update-manifests.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) Fs.rmSync(folder, { recursive: true, force: true });
});
const temporary = () => {
  const folder = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-manifests-"));
  folders.push(folder);
  return folder;
};

/** A feed file as electron-builder 26 writes it, `blockMapSize` included. */
const feed = (arch: string, ext: string, date: string, sha = `${arch}sha`) =>
  `version: 1.2.0\nfiles:\n  - url: Jhin-1.2.0-${arch}.${ext}\n    sha512: ${sha}\n    size: 7\n    blockMapSize: 3\npath: Jhin-1.2.0-${arch}.${ext}\nsha512: ${sha}\nreleaseDate: '${date}'\n`;

describe("merge-update-manifests", () => {
  it("merges arm64 and x64 macOS update manifests into one multi-arch manifest", () => {
    const arm64 = parsePlatformUpdateManifest(
      "mac",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: T3-Code-0.0.4-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: T3-Code-0.0.4-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-mac.yml",
    );

    const x64 = parsePlatformUpdateManifest(
      "mac",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-x64.zip
    sha512: x64zip
    size: 132000112
  - url: T3-Code-0.0.4-x64.dmg
    sha512: x64dmg
    size: 138148807
path: T3-Code-0.0.4-x64.zip
sha512: x64zip
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-mac-x64.yml",
    );

    const merged = mergePlatformUpdateManifests("mac", arm64, x64);

    expect(merged.version).toBe("0.0.4");
    expect(merged.releaseDate).toBe("2026-03-07T10:36:07.540Z");
    expect(merged.files.map((file) => file.url)).toEqual([
      "T3-Code-0.0.4-arm64.zip",
      "T3-Code-0.0.4-arm64.dmg",
      "T3-Code-0.0.4-x64.zip",
      "T3-Code-0.0.4-x64.dmg",
    ]);

    const serialized = serializePlatformUpdateManifest("mac", merged);
    expect(serialized).not.toContain("path:");
    expect((serialized.match(/- url:/g) ?? []).length).toBe(4);
  });

  it("merges arm64 and x64 Windows update manifests into one multi-arch manifest", () => {
    const arm64 = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.exe
    sha512: arm64exe
    size: 125621344
  - url: T3-Code-0.0.4-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 131754
path: T3-Code-0.0.4-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-win-arm64.yml",
    );

    const x64 = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-x64.exe
    sha512: x64exe
    size: 132000112
  - url: T3-Code-0.0.4-x64.exe.blockmap
    sha512: x64blockmap
    size: 138148
path: T3-Code-0.0.4-x64.exe
sha512: x64exe
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-win-x64.yml",
    );

    const merged = mergePlatformUpdateManifests("win", arm64, x64);

    expect(merged.version).toBe("0.0.4");
    expect(merged.releaseDate).toBe("2026-03-07T10:36:07.540Z");
    expect(merged.files.map((file) => file.url)).toEqual([
      "T3-Code-0.0.4-arm64.exe",
      "T3-Code-0.0.4-arm64.exe.blockmap",
      "T3-Code-0.0.4-x64.exe",
      "T3-Code-0.0.4-x64.exe.blockmap",
    ]);

    const serialized = serializePlatformUpdateManifest("win", merged);
    expect(serialized).not.toContain("path:");
    expect((serialized.match(/- url:/g) ?? []).length).toBe(4);
  });

  it("rejects mismatched manifest versions", () => {
    const primary = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.exe
    sha512: arm64exe
    size: 1
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-win-arm64.yml",
    );

    const secondary = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.5
files:
  - url: T3-Code-0.0.5-x64.exe
    sha512: x64exe
    size: 1
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-win-x64.yml",
    );

    expect(() => mergePlatformUpdateManifests("win", primary, secondary)).toThrow(
      /different versions/,
    );
  });

  it("preserves quoted scalars as strings", () => {
    const manifest = parsePlatformUpdateManifest(
      "mac",
      `version: '1.0'
files:
  - url: T3-Code-1.0-x64.zip
    sha512: zipsha
    size: 1
releaseName: 'true'
minimumSystemVersion: '13.0'
stagingPercentage: 50
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-mac.yml",
    );

    expect(manifest.version).toBe("1.0");
    expect(manifest.extras.releaseName).toBe("true");
    expect(manifest.extras.minimumSystemVersion).toBe("13.0");
    expect(manifest.extras.stagingPercentage).toBe(50);
  });

  it("round-trips numeric-looking versions as strings", () => {
    const original = parsePlatformUpdateManifest(
      "win",
      `version: '1.0'
files:
  - url: T3-Code-1.0-x64.exe
    sha512: exesha
    size: 1
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-win-x64.yml",
    );

    const serialized = serializePlatformUpdateManifest("win", original);
    expect(serialized).toContain("version: '1.0'");

    const reparsed = parsePlatformUpdateManifest("win", serialized, "latest-win-x64.yml");
    expect(reparsed.version).toBe("1.0");
  });

  it("merges two feed files on disk into a third, as the release job runs it", () => {
    const folder = temporary();
    const write = (name: string, arch: string, date: string) => {
      const file = Path.join(folder, name);
      Fs.writeFileSync(
        file,
        `version: 1.2.0\nfiles:\n  - url: Jhin-1.2.0-${arch}.exe\n    sha512: ${arch}sha\n    size: 7\npath: Jhin-1.2.0-${arch}.exe\nsha512: ${arch}sha\nreleaseDate: '${date}'\n`,
      );
      return file;
    };
    const x64 = write("latest-win-x64.yml", "x64", "2026-10-22T10:00:00.000Z");
    const arm64 = write("latest-win-arm64.yml", "arm64", "2026-10-22T11:00:00.000Z");
    const output = Path.join(folder, "latest.yml");
    mergeUpdateManifestFiles("win", x64, arm64, output);
    expect(Fs.readFileSync(output, "utf8")).toBe(
      [
        "version: '1.2.0'",
        "files:",
        "  - url: Jhin-1.2.0-x64.exe",
        "    sha512: x64sha",
        "    size: 7",
        "  - url: Jhin-1.2.0-arm64.exe",
        "    sha512: arm64sha",
        "    size: 7",
        "releaseDate: '2026-10-22T11:00:00.000Z'",
        "",
      ].join("\n"),
    );
  });

  it("carries a file entry's other keys through, and refuses entries that disagree", () => {
    const x64 = parsePlatformUpdateManifest(
      "win",
      feed("x64", "exe", "2026-10-22T10:00:00.000Z"),
      "x64.yml",
    );
    const arm64 = parsePlatformUpdateManifest(
      "win",
      feed("arm64", "exe", "2026-10-22T11:00:00.000Z"),
      "arm64.yml",
    );
    const merged = mergePlatformUpdateManifests("win", x64, arm64);
    expect(merged.files.map((file) => file.extras)).toEqual([
      { blockMapSize: 3 },
      { blockMapSize: 3 },
    ]);
    expect(serializePlatformUpdateManifest("win", merged)).toContain("    blockMapSize: 3\n");

    const other = parsePlatformUpdateManifest(
      "win",
      feed("x64", "exe", "2026-10-22T11:00:00.000Z", "othersha"),
      "other.yml",
    );
    expect(() => mergePlatformUpdateManifests("win", x64, other)).toThrow(
      /conflicting file entry for Jhin-1\.2\.0-x64\.exe/,
    );
    const withName = (name: string) =>
      parsePlatformUpdateManifest(
        "mac",
        `${feed("x64", "zip", "2026-10-22T10:00:00.000Z").replace("releaseDate", `releaseName: '${name}'\nreleaseDate`)}`,
        "mac.yml",
      );
    expect(() => mergePlatformUpdateManifests("mac", withName("a"), withName("b"))).toThrow(
      /conflicting 'releaseName' values/,
    );
  });

  it("merges in place from the command line, as the feeds job runs it", () => {
    const folder = temporary();
    const arm64 = Path.join(folder, "latest-mac.yml");
    const x64 = Path.join(folder, "latest-mac-x64.yml");
    Fs.writeFileSync(arm64, feed("arm64", "zip", "2026-10-22T10:00:00.000Z"));
    Fs.writeFileSync(x64, feed("x64", "zip", "2026-10-22T11:00:00.000Z"));
    const script = Path.join(import.meta.dirname, "update-manifests.ts");
    ChildProcess.execFileSync(process.execPath, [script, "--platform", "mac", arm64, x64]);
    const merged = parsePlatformUpdateManifest("mac", Fs.readFileSync(arm64, "utf8"), arm64);
    expect(merged.files.map((file) => file.url)).toEqual([
      "Jhin-1.2.0-arm64.zip",
      "Jhin-1.2.0-x64.zip",
    ]);

    const usage = ChildProcess.spawnSync(process.execPath, [script, "--platform", "linux", arm64], {
      encoding: "utf8",
    });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage: node scripts/update-manifests.ts");
  });
});
