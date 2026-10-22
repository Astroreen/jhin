// The cases follow T3 Code's scripts/merge-update-manifests.test.ts (MIT, see THIRD_PARTY_NOTICES.md).
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  mergePlatformUpdateManifests,
  mergeUpdateManifestFiles,
  parsePlatformUpdateManifest,
  serializePlatformUpdateManifest,
} from "./update-manifests.ts";

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
    const folder = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-manifests-"));
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
});
