import { describe, expect, it } from "vite-plus/test";

import { threadRoute } from "../src/plugins/chat/composer-chips.tsx";

describe("a thread chip's address (D1005)", () => {
  const local = { target: { node: "conn" }, nodeId: "self", selfNodeId: "self" };
  it("opens the composer's own node's thread, or another member's through the connection", () => {
    expect(threadRoute("jhin://self/threads/t%201", local)).toEqual({
      node: "conn",
      thread: "t 1",
    });
    expect(threadRoute("jhin://far/threads/t", local)).toEqual({
      node: "conn",
      remote: "far",
      thread: "t",
    });
    // From a remote member's composer, the connected node's own thread is no remote.
    const remote = { target: { node: "conn", remote: "far" }, nodeId: "far", selfNodeId: "self" };
    expect(threadRoute("jhin://far/threads/t", remote)).toEqual({
      node: "conn",
      remote: "far",
      thread: "t",
    });
    expect(threadRoute("jhin://self/threads/t", remote)).toEqual({ node: "conn", thread: "t" });
  });

  it("leads nowhere while the node's id is unknown, or for another address", () => {
    const unknown = { target: { node: "conn" }, nodeId: undefined, selfNodeId: undefined };
    expect(threadRoute("jhin://self/threads/t", unknown)).toBeUndefined();
    expect(threadRoute("jhin://self/agents/a", local)).toBeUndefined();
    expect(threadRoute("https://example.com", local)).toBeUndefined();
  });
});
