import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Zlib from "node:zlib";

/** Content codings the node sends, in the order it prefers them (loading.md D1583). */
export type Coding = "br" | "gzip";
const PREFERRED: readonly Coding[] = ["br", "gzip"];

/** File types whose bodies compress (loading.md D1582, D1584). */
const COMPRESSIBLE: Readonly<Record<string, true>> = {
  ".html": true,
  ".js": true,
  ".mjs": true,
  ".css": true,
  ".json": true,
  ".svg": true,
  ".webmanifest": true,
};

/** Smaller bodies are sent as they are: the framing would eat the gain. */
export const MIN_COMPRESS_BYTES = 1024;

export const compressible = (extension: string): boolean => COMPRESSIBLE[extension] === true;

/**
 * The coding to send for an `Accept-Encoding` header, among those `available`:
 * `br` before `gzip`, any q-value above 0 accepts, `q=0` refuses, `*` stands
 * for codings the header does not name. Undefined: send the body as it is.
 */
export function negotiate(
  header: string | string[] | undefined,
  available: readonly Coding[] = PREFERRED,
): Coding | undefined {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  const weights = new Map<string, number>();
  for (const part of value.split(",")) {
    const [name = "", ...params] = part.split(";").map((piece) => piece.trim());
    if (name === "") continue;
    let q = 1;
    for (const param of params) {
      const match = /^q=([0-9.]+)$/i.exec(param);
      if (match !== null) q = Number(match[1]);
    }
    weights.set(name.toLowerCase(), Number.isFinite(q) ? q : 0);
  }
  return PREFERRED.find((coding) => {
    if (!available.includes(coding)) return false;
    const q = weights.get(coding) ?? weights.get("*");
    return q !== undefined && q > 0;
  });
}

/**
 * Tags of files by their bytes (loading.md D1598), kept while the file's
 * size, times and inode stay: a packed install stamps every file with one
 * mtime, so size and mtime alone can name two versions of `index.html`.
 */
export function fileTagger(): (file: string, stat: Fs.Stats) => string {
  const tags = new Map<string, { readonly key: string; readonly tag: string }>();
  return (file, stat) => {
    const key = `${stat.size}-${stat.mtimeMs}-${stat.ctimeMs}-${stat.ino}`;
    const known = tags.get(file);
    if (known?.key === key) return known.tag;
    const tag = bodyTag(Fs.readFileSync(file));
    tags.set(file, { key, tag });
    return tag;
  };
}

/** A weak tag of a body: a hash of its bytes (loading.md D1585). */
export const bodyTag = (body: string | Buffer): string =>
  `W/"${Crypto.createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;

/** Whether `If-None-Match` names `tag`, compared weakly (RFC 9110 §13.1.2). */
export function matches(header: string | undefined, tag: string): boolean {
  if (header === undefined) return false;
  const opaque = (value: string) => value.trim().replace(/^W\//, "");
  return header.split(",").some((value) => value.trim() === "*" || opaque(value) === opaque(tag));
}

/** A compressing stream for a body sent as it is read (loading.md D1584). */
export const compressor = (coding: Coding): Zlib.BrotliCompress | Zlib.Gzip =>
  coding === "br"
    ? Zlib.createBrotliCompress({ params: { [Zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
    : Zlib.createGzip({ level: 6 });

/** A body compressed at once, with the same settings as `compressor`. */
export const compress = (coding: Coding, body: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer) =>
      error === null ? resolve(result) : reject(error);
    if (coding === "br")
      Zlib.brotliCompress(body, { params: { [Zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, done);
    else Zlib.gzip(body, { level: 6 }, done);
  });
