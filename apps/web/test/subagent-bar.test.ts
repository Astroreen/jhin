import type { ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { subagentStatus } from "../src/plugins/chat/subagent-bar.tsx";

const thread = (lastTurn?: ThreadRecord["lastTurn"]): ThreadRecord => ({
  id: "t",
  projectId: "p",
  title: "Explore",
  createdAt: "2026-10-21T10:00:00.000Z",
  ...(lastTurn === undefined ? {} : { lastTurn }),
});
const turn = (status: NonNullable<ThreadRecord["lastTurn"]>["status"], at: string) => ({
  turnId: "u",
  status,
  at,
  agentId: "jhin.agent-claude",
});

describe("a provider subagent's status (D880)", () => {
  it("is T3's: working with its time, completed in its time, or the state", () => {
    const now = Date.parse("2026-10-21T10:00:12.000Z");
    expect(subagentStatus(thread(), now)).toBe("Starting");
    expect(subagentStatus(thread(turn("running", "2026-10-21T10:00:00.000Z")), now)).toBe(
      "Working 12s",
    );
    expect(subagentStatus(thread(turn("completed", "2026-10-21T10:01:03.000Z")), now)).toBe(
      "Completed in 1m 3s",
    );
    expect(subagentStatus(thread(turn("failed", "2026-10-21T10:00:05.000Z")), now)).toBe("Failed");
  });
});
