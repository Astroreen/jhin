import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_API_VERSION } from "./index.ts";

describe("kernel", () => {
  it("exposes the plugin API version", () => {
    expect(PLUGIN_API_VERSION).toBe(2);
  });
});
