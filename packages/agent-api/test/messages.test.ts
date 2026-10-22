import { describe, expect, it } from "vite-plus/test";

import {
  AgentMessage,
  MAX_MESSAGE_LENGTH,
  MessageCommands,
  messageText,
  ownerAddress,
  parseMessageAddress,
  threadAddress,
} from "../src/index.ts";

const message: AgentMessage = {
  messageId: "m1",
  kind: "message",
  from: "jhin://node-a/agents/lead",
  to: "jhin://node-b/agents/builder",
  body: "Slice 3 is yours.",
  traceId: "t1",
  sentAt: "2026-10-21T00:00:00.000Z",
};

describe("messaging contract", () => {
  it("parses the three kinds of party", () => {
    expect(parseMessageAddress("jhin://node-a/agents/lead")).toEqual({
      kind: "agent",
      nodeId: "node-a",
      agentId: "lead",
    });
    expect(parseMessageAddress(ownerAddress("node-a"))).toEqual({
      kind: "owner",
      nodeId: "node-a",
    });
    expect(parseMessageAddress(threadAddress("node-a", "t-1"))).toEqual({
      kind: "thread",
      nodeId: "node-a",
      threadId: "t-1",
    });
    for (const address of [
      "jhin://node-a",
      "jhin://node-a/owner/x",
      "jhin://node-a/threads/..",
      "jhin://node-a/agents/..",
      "https://node-a/owner",
    ]) {
      expect(parseMessageAddress(address)).toBeUndefined();
    }
  });

  it("bounds what a message carries", () => {
    const send = MessageCommands["agents.send"].input;
    expect(send.safeParse({ to: "jhin://n/owner", body: "hi" }).success).toBe(true);
    expect(send.safeParse({ to: "jhin://n/owner", body: "" }).success).toBe(false);
    expect(
      send.safeParse({ to: "jhin://n/owner", body: "x".repeat(MAX_MESSAGE_LENGTH + 1) }).success,
    ).toBe(false);
    expect(send.safeParse({ to: "jhin://n/owner", body: "hi", messageId: "../x" }).success).toBe(
      false,
    );
    const ask = MessageCommands["agents.ask"].input;
    expect(ask.safeParse({ to: "jhin://n/agents/a", question: "?", generation: 0 }).success).toBe(
      false,
    );
  });

  it("tells the recipient who sent it, the trace and how to reply", () => {
    const text = messageText(message);
    expect(text).toContain("jhin://node-a/agents/lead");
    expect(text).toContain("trace t1");
    expect(text).toContain("agents_send");
    expect(text.endsWith("Slice 3 is yours.")).toBe(true);
    expect(messageText({ ...message, kind: "ask", generation: 2 })).toContain("generation #2");
    expect(messageText({ ...message, kind: "answer", inReplyTo: "q1" })).toContain(
      "your message q1",
    );
  });
});
