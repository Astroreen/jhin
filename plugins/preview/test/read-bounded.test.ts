import { describe, expect, it } from "vite-plus/test";

import { readBounded } from "../src/read-bounded.ts";

/** A file whose size was `statSize` when asked, and that holds `content` when read. */
const file = (content: string, statSize = content.length) => {
  const bytes = Buffer.from(content);
  return {
    stat: async () => ({ size: statSize }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length)),
    }),
  };
};

describe("a download read with its bound (D1331)", () => {
  it("reads a file within the bound whole, also one that grew within it", async () => {
    expect(String(await readBounded(file("hello"), 5))).toBe("hello");
    expect(String(await readBounded(file("hello there", 2), 20))).toBe("hello there");
    expect(String(await readBounded(file(""), 5))).toBe("");
  });

  it("refuses a file past the bound, also one that grew past it after its size was taken", async () => {
    expect(await readBounded(file("hello!"), 5)).toBeUndefined();
    expect(await readBounded(file("hello there", 3), 5)).toBeUndefined();
  });
});
