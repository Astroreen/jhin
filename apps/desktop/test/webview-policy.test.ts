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

  it("resets every preference a page's webview params may have set (D1323)", () => {
    const hostile: Electron.WebPreferences = {
      preload: "/tmp/evil.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      enableBlinkFeatures: "Serial",
      webviewTag: true,
    };
    const params: Record<string, string> = {
      partition: "jhin-preview-incognito-tab_1_abcd1234",
      src: "https://example.com/",
      preload: "file:///tmp/evil.js",
      nodeintegration: "on",
      nodeintegrationinsubframes: "on",
      disablewebsecurity: "on",
      webpreferences: "contextIsolation=no, sandbox=no",
    };
    expect(hardenWebview(hostile, params)).toBe(true);
    expect(hostile).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      disableHtmlFullscreenWindowResize: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: "",
      webviewTag: false,
    });
    for (const param of [
      "preload",
      "nodeintegration",
      "nodeintegrationinsubframes",
      "disablewebsecurity",
      "webpreferences",
    ]) {
      expect(params[param]).toBeUndefined();
    }
  });

  it("refuses partitions near the preview's but not its own", () => {
    for (const partition of [
      "persist:jhin-preview-",
      "jhin-preview-agent-",
      "persist:jhin-preview-a/b",
      "jhin-preview-other-tab_1",
      "persist:JHIN-PREVIEW-x",
      " persist:jhin-preview-x",
    ]) {
      expect(hardenWebview({}, { partition, src: "about:blank" })).toBe(false);
    }
  });
});
