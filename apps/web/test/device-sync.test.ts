import { describe, expect, it } from "vite-plus/test";

import { reconcile, shared } from "../src/plugins/device-sync-engine.ts";

describe("device settings across devices (D487, D488)", () => {
  it("takes what the node has later and sends what this device has later", () => {
    const times: Record<string, number> = {
      "jhin.chat": 10,
      "jhin.appearance": 50,
      "jhin.sync": 99,
    };
    expect(
      reconcile(
        {
          "jhin.chat": { values: { sendShortcut: "mod-enter" }, at: 20 },
          "jhin.appearance": { values: {}, at: 40 },
          "jhin.diff": { values: { wordWrap: true }, at: 5 },
          "jhin.sync": { values: { settings: false }, at: 100 },
        },
        { sections: Object.keys(times), changedAt: (section) => times[section] },
      ),
    ).toEqual({ take: ["jhin.chat", "jhin.diff"], send: ["jhin.appearance"] });
  });

  it("never shares what says what is shared", () => {
    expect(shared("jhin.sync")).toBe(false);
    expect(shared("jhin.history-cache")).toBe(false);
    expect(shared("jhin.chat")).toBe(true);
  });
});
