import { describe, expect, it } from "vite-plus/test";

import { hardenWebview, openLinkUrl } from "../src/preview/webview-policy.ts";

describe("the preview's webviews (D1323)", () => {
  it("hardens a webview of a preview partition and refuses any other", () => {
    const preferences: Electron.WebPreferences = {
      preload: "/somewhere/preload.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    };
    expect(
      hardenWebview(preferences, {
        partition: "persist:jhin-preview-ZGVmYXVsdA",
        src: "about:blank",
      }),
    ).toBe(true);
    expect(preferences).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      disableHtmlFullscreenWindowResize: true,
    });
    expect(preferences.preload).toBeUndefined();
    expect(hardenWebview({}, { partition: "jhin-preview-agent-tab_1_abcd1234", src: "" })).toBe(
      true,
    );
    for (const params of [
      { partition: "persist:main" },
      { partition: "" },
      {},
      { partition: "persist:jhin-preview-ZGVmYXVsdA", src: "file:///etc/passwd" },
      { partition: "persist:jhin-preview-ZGVmYXVsdA", src: "javascript:alert(1)" },
    ]) {
      expect(hardenWebview({}, params as Record<string, string>)).toBe(false);
    }
  });

  it("opens only http(s) windows as tabs", () => {
    expect(openLinkUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(openLinkUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
    for (const url of [
      "about:blank",
      "",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(openLinkUrl(url)).toBeUndefined();
    }
  });
});
