// The browser's surfaces of the right panel (t3-parity.md D1424): which tabs are surfaces, and
// closing them on the node, as T3's reconcileBrowserSurfaces and useRightPanelSurfaceClose.
import type { PreviewTab } from "@jhin/preview-api";
import { describe, expect, it } from "vite-plus/test";

import {
  agentBrowserCloseQuestion,
  browserSurfaceResources,
  releaseBrowserTabs,
} from "../src/plugins/preview/surfaces.ts";

const tab = (tabId: string, change: Partial<PreviewTab> = {}) =>
  ({ tabId, reveal: true, owner: "human", controller: null, ...change }) as PreviewTab;

const surface = (resource: string) => ({ id: `browser:${resource}`, kind: "browser", resource });

describe("browser surfaces", () => {
  it("are the thread's tabs, but not a hidden one unless it already shows", () => {
    const tabs = [
      tab("a"),
      tab("popup", { reveal: false }),
      tab("app", { reveal: false, desktop: true }),
    ];
    expect(browserSurfaceResources(tabs, new Set())).toEqual(["a", "app"]);
    expect(browserSurfaceResources(tabs, new Set(["popup", "new"]))).toEqual([
      "a",
      "popup",
      "app",
      "new",
    ]);
  });

  it("asks T3's question before closing tabs an agent drives", () => {
    expect(agentBrowserCloseQuestion(0)).toBeUndefined();
    expect(agentBrowserCloseQuestion(1)?.title).toBe("Close browser while the agent is using it?");
    expect(agentBrowserCloseQuestion(2)?.title).toBe(
      "Close 2 browsers while the agent is using them?",
    );
  });

  it("closes the tabs on the node, and keeps the surfaces when one does not close", async () => {
    const closed: string[] = [];
    const asked: string[] = [];
    const tabs = [tab("a"), tab("b", { owner: "agent" }), tab("c")];
    const release = (closing: string[], options: { answer?: boolean; fail?: string } = {}) =>
      releaseBrowserTabs({
        tabs,
        closing: closing.map(surface),
        confirm: (question) => {
          asked.push(question.title);
          return Promise.resolve(options.answer ?? true);
        },
        close: (tabId) => {
          if (tabId === options.fail) return Promise.reject(new Error("gone"));
          closed.push(tabId);
          return Promise.resolve();
        },
      });
    expect(await release(["a", "new"])).toBe(true);
    expect(asked).toEqual([]);
    expect(await release(["b"], { answer: false })).toBe(false);
    expect(asked).toEqual(["Close browser while the agent is using it?"]);
    expect(await release(["b", "c"], { fail: "c" })).toBe(false);
    expect(closed).toEqual(["a", "b"]);
  });
});
