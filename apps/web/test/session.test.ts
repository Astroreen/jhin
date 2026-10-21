import { describe, expect, it } from "vite-plus/test";

import { httpBase, looksLikePairingCode, parsePairingUrl, rpcUrl } from "../src/lib/session.ts";

describe("pairing links (security.md D422)", () => {
  it("reads the node and the code from T3's pairing link", () => {
    expect(parsePairingUrl("https://jhin.example.com/pair#token=ABCDEFGHJKMN")).toEqual({
      url: "wss://jhin.example.com/rpc",
      code: "ABCDEFGHJKMN",
    });
    expect(parsePairingUrl("http://127.0.0.1:7777/pair?token=ABCDEFGHJKMN")).toEqual({
      url: "ws://127.0.0.1:7777/rpc",
      code: "ABCDEFGHJKMN",
    });
    for (const text of ["ABCDEFGHJKMN", "https://x.example/pair", "ws://x/rpc#token=A"]) {
      expect(parsePairingUrl(text)).toBeUndefined();
    }
  });

  it("tells a pairing code from a token, as people type it", () => {
    expect(looksLikePairingCode("abcd-efgh jkmn")).toBe(true);
    // 0, 1, I and O are not in T3's alphabet; a token is much longer.
    expect(looksLikePairingCode("ABCD0FGHJKMN")).toBe(false);
    expect(looksLikePairingCode("nlkhWcFv5pGUK-DX_4WdUaUtomEVWjmKDpyxxv1XzTs")).toBe(false);
  });

  it("maps a node's RPC address to its HTTP one and back", () => {
    expect(httpBase("wss://jhin.example.com/rpc")).toBe("https://jhin.example.com");
    expect(httpBase("ws://127.0.0.1:7777/rpc")).toBe("http://127.0.0.1:7777");
    expect(rpcUrl("https://jhin.example.com/")).toBe("wss://jhin.example.com/rpc");
    // A node under a path behind a proxy keeps it; a pairing link's /pair does not count.
    expect(rpcUrl("https://h.example/jhin/")).toBe("wss://h.example/jhin/rpc");
    expect(parsePairingUrl("https://h.example/jhin/pair#token=ABCDEFGHJKMN")?.url).toBe(
      "wss://h.example/jhin/rpc",
    );
    expect(httpBase(rpcUrl("https://h.example/jhin/"))).toBe("https://h.example/jhin");
  });
});
