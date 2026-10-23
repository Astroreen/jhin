import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createDeviceKey } from "../src/lib/dpop.ts";
import { pairWithCode } from "../src/lib/session.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pairing with a key (security.md D1368)", () => {
  it("sends a proof, and pairs without one when an older node's preflight refuses it", async () => {
    const key = await createDeviceKey();
    expect(key).toBeDefined();
    const sent: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers);
      // A node from before D1366: its CORS preflight allows no `dpop` header.
      if ("dpop" in init.headers) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ token: "jhd1.a.b" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const paired = await pairWithCode("ws://node.example:7777/rpc", "ABCDEFGHJKLM", "Browser", key);
    expect(paired).toEqual({ token: "jhd1.a.b" });
    expect(sent).toHaveLength(2);
    expect(sent[0]!["dpop"]).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sent[1]).not.toHaveProperty("dpop");
  });
});
