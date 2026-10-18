import type { ThreadRecord } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { notificationKind } from "../src/plugins/notifications.tsx";

type LastTurn = NonNullable<ThreadRecord["lastTurn"]>;

const turn = (status: LastTurn["status"], extra: Partial<LastTurn> = {}): LastTurn => ({
  turnId: "u1",
  status,
  at: "2026-10-18T12:00:00.000Z",
  agentId: "fake",
  ...extra,
});

describe("notificationKind", () => {
  it("announces endings and requests for input", () => {
    expect(notificationKind(turn("running"), turn("completed"))).toBe("completion");
    expect(notificationKind(turn("running"), turn("failed"))).toBe("failed");
    expect(notificationKind(turn("running"), turn("waiting", { waitingFor: "approval" }))).toBe(
      "approval",
    );
    expect(notificationKind(turn("running"), turn("waiting", { waitingFor: "user-input" }))).toBe(
      "input",
    );
  });

  it("stays quiet when nothing new happened", () => {
    expect(notificationKind(turn("completed"), turn("completed"))).toBeUndefined();
    expect(notificationKind(undefined, turn("running"))).toBeUndefined();
    expect(notificationKind(turn("running"), turn("interrupted"))).toBeUndefined();
    expect(notificationKind(turn("completed"), undefined)).toBeUndefined();
  });

  it("announces a new turn even when it ends the same way", () => {
    expect(notificationKind(turn("completed"), turn("completed", { turnId: "u2" }))).toBe(
      "completion",
    );
  });
});
