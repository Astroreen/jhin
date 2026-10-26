import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Util from "node:util";
import * as Zlib from "node:zlib";

import type { Plugin } from "vite";

/** Types whose bodies compress; images and fonts already are (loading.md D1582). */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest"]);
const MIN_BYTES = 1024;

const brotli = Util.promisify(Zlib.brotliCompress);
const gzip = Util.promisify(Zlib.gzip);

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await Fs.readdir(dir, { withFileTypes: true })) {
    const path = Path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * Writes `<file>.br` (brotli, quality 11) and `<file>.gz` (gzip, level 9) next
 * to each compressible file of `dir` of at least 1 KiB, unless the compressed
 * body would be larger (loading.md D1582). Returns the files it wrote.
 */
export async function precompressDir(dir: string): Promise<string[]> {
  const written: string[] = [];
  const queue: string[] = [];
  for await (const file of files(dir)) if (COMPRESSIBLE.has(Path.extname(file))) queue.push(file);
  // A few at a time: brotli 11 over the whole of dist/ at once would hold it all in memory.
  const worker = async () => {
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      const body = await Fs.readFile(file);
      if (body.length < MIN_BYTES) continue;
      const [br, gz] = await Promise.all([
        brotli(body, {
          params: {
            [Zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [Zlib.constants.BROTLI_PARAM_MODE]: Zlib.constants.BROTLI_MODE_TEXT,
            [Zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        }),
        gzip(body, { level: 9 }),
      ]);
      for (const [extension, compressed] of [
        [".br", br],
        [".gz", gz],
      ] as const) {
        if (compressed.length >= body.length) continue;
        await Fs.writeFile(`${file}${extension}`, compressed);
        written.push(`${file}${extension}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return written.toSorted();
}

/** The build's compressed siblings, written once the bundle is on disk. */
export function precompress(): Plugin {
  let outDir = "";
  return {
    name: "jhin-precompress",
    apply: "build",
    configResolved(config) {
      outDir = Path.resolve(config.root, config.build.outDir);
    },
    // After the bundle is written, which a failed build never reaches.
    async writeBundle() {
      await precompressDir(outDir);
    },
  };
}
