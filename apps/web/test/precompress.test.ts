import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { precompressDir } from "../precompress.ts";

describe("precompressDir (loading.md D1582)", () => {
  it("writes .br and .gz next to compressible files of 1 KiB and more, nothing else", async () => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-precompress-"));
    Fs.mkdirSync(Path.join(dir, "assets"));
    const app = "export const jhin = 'compress me';\n".repeat(200);
    Fs.writeFileSync(Path.join(dir, "assets", "app.js"), app);
    Fs.writeFileSync(Path.join(dir, "index.html"), `<html>${"<p>jhin</p>".repeat(200)}</html>`);
    Fs.writeFileSync(Path.join(dir, "small.css"), "a{color:red}");
    Fs.writeFileSync(Path.join(dir, "icon.png"), Buffer.alloc(4096, 1));
    // Random bytes do not compress: their siblings would be larger.
    Fs.writeFileSync(Path.join(dir, "noise.json"), Crypto.randomBytes(4096));

    const written = await precompressDir(dir);

    expect(written.map((file) => Path.relative(dir, file))).toEqual([
      "assets/app.js.br",
      "assets/app.js.gz",
      "index.html.br",
      "index.html.gz",
    ]);
    expect(
      Zlib.brotliDecompressSync(Fs.readFileSync(Path.join(dir, "assets", "app.js.br"))).toString(),
    ).toBe(app);
    expect(Zlib.gunzipSync(Fs.readFileSync(Path.join(dir, "assets", "app.js.gz"))).toString()).toBe(
      app,
    );
  });
});
