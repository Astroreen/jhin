import * as Fs from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { lockedPins, packedManifest } from "./packing.ts";

describe("packedManifest", () => {
  it("applies publishConfig.jhin to jhin and keeps the other publishConfig fields", () => {
    const packed = packedManifest({
      name: "@jhin/plugin-x",
      jhin: { id: "jhin.x", side: "server", entry: "src/index.ts" },
      publishConfig: { access: "public", jhin: { entry: "dist/index.js" } },
    });
    expect(packed).toEqual({
      name: "@jhin/plugin-x",
      jhin: { id: "jhin.x", side: "server", entry: "dist/index.js" },
      publishConfig: { access: "public" },
    });
  });

  it("drops an emptied publishConfig and leaves packages without publishConfig.jhin alone", () => {
    expect(
      packedManifest({ jhin: { entry: "src/index.ts" }, publishConfig: { jhin: { entry: "a" } } }),
    ).toEqual({ jhin: { entry: "a" } });
    const library = { name: "@jhin/sdk", publishConfig: { exports: "./dist/index.js" } };
    expect(packedManifest(library)).toBe(library);
  });

  it("refuses publishConfig.jhin without a jhin manifest", () => {
    expect(() => packedManifest({ publishConfig: { jhin: { entry: "a" } } })).toThrow(
      'without "jhin"',
    );
  });
});

const LOCKFILE = `lockfileVersion: '9.0'

packages:

  '@scope/one@1.2.3':
    resolution: {integrity: sha512-a}

  plain@4.0.0:
    resolution: {integrity: sha512-b}

  twice@1.0.0:
    resolution: {integrity: sha512-c}

  twice@2.1.0:
    resolution: {integrity: sha512-d}

  zero@0.3.1:
    resolution: {integrity: sha512-e}

  zero@0.4.0:
    resolution: {integrity: sha512-f}

  same-line@1.32.0:
    resolution: {integrity: sha512-g}

  same-line@1.33.0:
    resolution: {integrity: sha512-h}

  from-git@git+https://github.com/owner/repo.git#abc123:
    resolution: {tarball: https://codeload.github.com/owner/repo/tar.gz/abc123}

  '@scope/from-tarball@https://example.com/pkg-1.0.0.tgz':
    resolution: {tarball: https://example.com/pkg-1.0.0.tgz}

snapshots:

  plain@4.0.0: {}
`;

describe("lockedPins", () => {
  it("pins single versions by name and several versions by their major or 0.x minor", () => {
    const { pins, unpinned } = lockedPins(LOCKFILE);
    expect(Object.fromEntries(pins)).toEqual({
      "@scope/one": "1.2.3",
      plain: "4.0.0",
      "twice@1": "1.0.0",
      "twice@2": "2.1.0",
      "zero@0.3": "0.3.1",
      "zero@0.4": "0.4.0",
    });
    expect(unpinned).toEqual([
      "from-git@git+https://github.com/owner/repo.git#abc123",
      "@scope/from-tarball@https://example.com/pkg-1.0.0.tgz",
      "same-line (1.32.0, 1.33.0)",
    ]);
  });

  it("fails loudly when it finds no packages", () => {
    expect(() => lockedPins("lockfileVersion: '9.0'\n")).toThrow("found no packages to pin");
  });

  it("reads the workspace lockfile", () => {
    const lockfile = Fs.readFileSync(Path.join(import.meta.dirname, "../pnpm-lock.yaml"), "utf8");
    const { pins } = lockedPins(lockfile);
    expect(pins.get("zod")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.size).toBeGreaterThan(100);
  });
});
