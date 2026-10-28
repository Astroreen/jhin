import type { ChatToolGroup } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { createToolPresentations } from "../src/plugins/chat/tool-presentations.ts";

const group = (id: string): ChatToolGroup => ({
  id,
  past: "Used",
  infinitive: "use",
  object: (count) => `${id} ${count}`,
});
const call = (name: string) => ({ name, kind: "mcp" as const, title: name });

describe("chat.tools@1 (preview.md D1681)", () => {
  it("finds a described command by its MCP tool under each agent's prefix", () => {
    const tools = createToolPresentations();
    const labels = ["Wait", "Waiting", "Waited", "for the preview page"] as const;
    tools.describe("preview.wait.for", { labels, group: group("browser") });
    const present = tools.present();
    for (const name of [
      "mcp__jhin__preview_wait_for",
      "jhin.preview_wait_for",
      "jhin_preview_wait_for",
    ]) {
      expect(present(call(name))?.labels).toEqual(labels);
    }
    expect(present(call("mcp__jhin__preview_click"))).toBeUndefined();
  });

  it("tells subscribers of every change, and the latest description wins until disposed", () => {
    const tools = createToolPresentations();
    const changes: number[] = [];
    tools.subscribe(() => changes.push(changes.length));
    const first = tools.describe("device.list", {
      labels: ["List", "Listing", "Listed", "devices"],
      group: group("one"),
    });
    const before = tools.present();
    const second = tools.describe("device.list", {
      labels: ["List", "Listing", "Listed", "devices"],
      group: group("two"),
    });
    // A new snapshot after each change, so React renders again.
    expect(tools.present()).not.toBe(before);
    expect(tools.present()(call("mcp__jhin__device_list"))?.group.id).toBe("two");
    second.dispose();
    expect(tools.present()(call("mcp__jhin__device_list"))?.group.id).toBe("one");
    first.dispose();
    expect(tools.present()(call("mcp__jhin__device_list"))).toBeUndefined();
    expect(changes).toHaveLength(4);
  });
});
