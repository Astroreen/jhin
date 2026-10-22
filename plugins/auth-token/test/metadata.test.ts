import { describe, expect, it } from "vite-plus/test";

import { deriveClientMetadata } from "../src/metadata.ts";

describe("a device's metadata (security.md D1187)", () => {
  const of = (userAgent: string | undefined, ipAddress?: string) =>
    deriveClientMetadata({ userAgent, ipAddress });

  it("reads T3's device type, OS and browser from the User-Agent", () => {
    expect(
      of("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Edg/140.0"),
    ).toMatchObject({ deviceType: "desktop", os: "Windows", browser: "Edge" });
    expect(of("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Firefox/140.0")).toMatchObject({
      deviceType: "desktop",
      os: "macOS",
      browser: "Firefox",
    });
    expect(
      of("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36"),
    ).toMatchObject({ deviceType: "mobile", os: "Android", browser: "Chrome" });
    expect(of("Mozilla/5.0 (X11; Linux x86_64) Jhin/0.1 Electron/38.0 Chrome/140.0")).toMatchObject(
      { deviceType: "desktop", os: "Linux", browser: "Electron" },
    );
    expect(of("Googlebot/2.1")).toMatchObject({ deviceType: "bot" });
  });

  it("keeps what is unknown unknown, and the client's header short", () => {
    expect(of(undefined)).toEqual({ deviceType: "unknown" });
    expect(of("   ")).toEqual({ deviceType: "unknown" });
    expect(of("x".repeat(2000)).userAgent).toHaveLength(512);
  });

  it("lets what the device presents win, and unwraps IPv4-mapped addresses", () => {
    expect(
      deriveClientMetadata({
        userAgent: "curl/8.0",
        ipAddress: "::ffff:192.168.1.20",
        presented: { deviceType: "tablet", os: "iPadOS" },
      }),
    ).toMatchObject({ deviceType: "tablet", os: "iPadOS", ipAddress: "192.168.1.20" });
  });
});
