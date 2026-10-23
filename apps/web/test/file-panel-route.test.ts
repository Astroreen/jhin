import type { Navigation, Route } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { FILE_PANEL, openFilePanel } from "../src/plugins/chat/file-panel-route.ts";

function navigation(start: Route) {
  let current = start;
  const visited: Route[] = [];
  const nav = {
    current: () => current,
    navigate: (route: Route) => {
      visited.push(route);
      current = route;
    },
    subscribe: () => ({ dispose: () => undefined }),
  } as unknown as Navigation;
  return { nav, visited };
}

describe("opening a file beside a thread (D1342)", () => {
  it("goes to the chip's own thread on its node, in place of the panel it had", () => {
    const { nav, visited } = navigation({ node: "a", thread: "other", panel: "diff" });
    openFilePanel(nav, { target: { node: "a", remote: "r" }, threadId: "t1" }, "src/a.ts");
    expect(visited).toEqual([
      { node: "a", remote: "r", thread: "t1", panel: FILE_PANEL, section: "src/a.ts" },
    ]);
  });

  it("opens a draft's file beside the project's draft, and keeps the mode", () => {
    const { nav, visited } = navigation({ node: "a", project: "p1", mode: "civilization" });
    openFilePanel(nav, { target: { node: "a" }, projectId: "p1" }, "README.md");
    expect(visited).toEqual([
      { node: "a", project: "p1", panel: FILE_PANEL, section: "README.md", mode: "civilization" },
    ]);
  });

  it("does nothing when that file already shows there", () => {
    const { nav, visited } = navigation({
      node: "a",
      thread: "t1",
      panel: FILE_PANEL,
      section: "src/a.ts",
    });
    openFilePanel(nav, { target: { node: "a" }, threadId: "t1" }, "src/a.ts");
    expect(visited).toEqual([]);
  });
});
