import { describe, expect, it } from "vite-plus/test";

import { readRoute, writeRoute } from "../src/plugins/navigation.ts";

describe("routes in the fragment", () => {
  it("round-trips every field", () => {
    const route = {
      node: "ws://127.0.0.1:7777/rpc",
      remote: "node-b",
      thread: "t1",
      project: "p1",
      panel: "settings",
      section: "keybindings",
      anchor: "jhin.web-ui",
      mode: "civilization",
    };
    expect(readRoute(`#${writeRoute(route)}`)).toEqual(route);
  });

  it("leaves out what is not set and ignores unknown keys", () => {
    expect(writeRoute({ node: "a" })).toBe("n=a");
    expect(readRoute("#n=a&x=1")).toEqual({ node: "a" });
    expect(readRoute("")).toEqual({});
  });

  it("names a config section of the settings page as its anchor (config-ui.md D1628)", () => {
    expect(writeRoute({ panel: "settings", section: "node-config", anchor: "jhin.web-ui" })).toBe(
      "p=settings&s=node-config&a=jhin.web-ui",
    );
  });
});
