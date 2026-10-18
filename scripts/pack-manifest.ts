// Points a plugin's manifest at its built JavaScript while the package is packed.
//
//   node ../../scripts/pack-manifest.ts prepack    (the package's "prepack" script)
//   node ../../scripts/pack-manifest.ts postpack   (the package's "postpack" script)
//
// In the workspace a plugin's `jhin.entry` is TypeScript (src/index.ts), run by
// Node directly and hot reloaded (D14). Node does not strip types under
// node_modules, so the packed manifest must name the built file instead. pnpm
// applies `publishConfig` to standard fields (`exports`, `bin`) but not to
// `jhin`; this does the same for `publishConfig.jhin`: prepack merges it into
// `jhin` and keeps the original package.json aside, postpack restores it.

import * as Fs from "node:fs";
import * as Path from "node:path";

const MANIFEST = Path.resolve("package.json");
const BACKUP = Path.resolve("node_modules/.jhin-pack/package.json");

function restore(): void {
  if (!Fs.existsSync(BACKUP)) return;
  Fs.copyFileSync(BACKUP, MANIFEST);
  Fs.rmSync(Path.dirname(BACKUP), { recursive: true, force: true });
}

const mode = process.argv[2];
if (mode === "postpack") {
  restore();
} else if (mode === "prepack") {
  // A pack that failed before postpack left the packed manifest behind.
  restore();
  const text = Fs.readFileSync(MANIFEST, "utf8");
  const manifest = JSON.parse(text) as {
    jhin?: Record<string, unknown>;
    publishConfig?: { jhin?: Record<string, unknown> } & Record<string, unknown>;
  };
  const { jhin: override, ...publishConfig } = manifest.publishConfig ?? {};
  if (manifest.jhin === undefined || override === undefined) {
    throw new Error(`${MANIFEST}: expected "jhin" and "publishConfig.jhin"`);
  }
  Fs.mkdirSync(Path.dirname(BACKUP), { recursive: true });
  Fs.writeFileSync(BACKUP, text);
  const packed = { ...manifest, jhin: { ...manifest.jhin, ...override }, publishConfig };
  Fs.writeFileSync(MANIFEST, `${JSON.stringify(packed, null, 2)}\n`);
} else {
  throw new Error("usage: pack-manifest.ts prepack|postpack");
}
