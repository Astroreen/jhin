import { describe, expect, it } from "vite-plus/test";

import { startThread } from "../src/lib/thread-actions.ts";

/** A node that creates thread `t1` and answers the other calls as told. */
function fakeNode(fail: { send?: Error; delete?: Error } = {}) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    call: async <T>(_target: unknown, method: string, params?: unknown): Promise<T> => {
      calls.push([method, params]);
      if (method === "threads.create") return { id: "t1" } as T;
      if (method === "threads.send" && fail.send !== undefined) throw fail.send;
      if (method === "threads.delete" && fail.delete !== undefined) throw fail.delete;
      return {} as T;
    },
  };
}

const target = { node: "ws://a/rpc" };
const first = {
  projectId: "scratch",
  text: "hello",
  attachments: [],
  selection: { agentId: "jhin.agent-fake" },
};

describe("startThread", () => {
  it("creates the thread with the chosen agent and sends its first message", async () => {
    const node = fakeNode();
    expect(await startThread(node, target, first)).toEqual({ threadId: "t1" });
    expect(node.calls).toEqual([
      ["threads.create", { projectId: "scratch", agentId: "jhin.agent-fake" }],
      ["threads.send", { threadId: "t1", text: "hello", agentId: "jhin.agent-fake" }],
    ]);
  });

  it("deletes the thread again when its first message cannot be sent", async () => {
    const node = fakeNode({ send: new Error("No agent runtime is installed on this node") });
    await expect(startThread(node, target, first)).rejects.toThrow("No agent runtime");
    expect(node.calls.map(([method]) => method)).toEqual([
      "threads.create",
      "threads.send",
      "threads.delete",
    ]);
    expect(node.calls.at(-1)).toEqual(["threads.delete", { threadId: "t1" }]);
  });

  it("keeps the thread when the message may have reached the node all the same", async () => {
    const dropped = Object.assign(new Error("Connection closed before the call completed"), {
      code: "DISCONNECTED",
    });
    const node = fakeNode({ send: dropped });
    expect(await startThread(node, target, first)).toEqual({ threadId: "t1", uncertain: dropped });
    expect(node.calls.map(([method]) => method)).toEqual(["threads.create", "threads.send"]);
  });

  it("reports the send's failure even when the clean-up fails too", async () => {
    const node = fakeNode({ send: new Error("Not connected"), delete: new Error("Not connected") });
    await expect(startThread(node, target, first)).rejects.toThrow("Not connected");
  });
});
