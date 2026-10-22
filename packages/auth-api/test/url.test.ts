import { describe, expect, it } from "vite-plus/test";

import { isPlainHttpUrl } from "../src/index.ts";

describe("a node address for a pairing link (D1190)", () => {
  it("is http(s), perhaps under a path, never with credentials, query or fragment", () => {
    expect(isPlainHttpUrl("http://192.168.1.20:7777")).toBe(true);
    expect(isPlainHttpUrl("https://studio.tail1234.ts.net/jhin/")).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "ftp://x.example",
      "https://user:pass@x.example",
      "https://x.example/?a=1",
      "https://x.example/#t",
      "not a url",
    ]) {
      expect(isPlainHttpUrl(bad)).toBe(false);
    }
  });
});
