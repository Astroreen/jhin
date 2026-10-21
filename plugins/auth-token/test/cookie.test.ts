import { readCookie } from "@jhin/auth-api";
import { describe, expect, it } from "vite-plus/test";

describe("readCookie (security.md D421)", () => {
  it("reads a cookie by name and gives no value for a malformed escape", () => {
    expect(readCookie("a=1; jhin_session_7777=jhd1.x%2Ey", "jhin_session_7777")).toBe("jhd1.x.y");
    expect(readCookie("jhin_session_7777=%", "jhin_session_7777")).toBeUndefined();
    expect(readCookie(undefined, "jhin_session_7777")).toBeUndefined();
  });
});
