import { describe, expect, it } from "vite-plus/test";

import { ReplayGuard } from "../src/dpop.ts";
import { TicketStore } from "../src/tickets.ts";

describe("WebSocket tickets (security.md D1367)", () => {
  it("are used once, expire after 60 seconds, and are not spent by a wrong secret", () => {
    const tickets = new TicketStore();
    const first = tickets.issue("device", 1_000)!;
    expect(first.expiresAt).toBe(61_000);
    expect(tickets.redeem(first.ticket, 2_000)).toBe("device");
    expect(tickets.redeem(first.ticket, 2_000)).toBeUndefined();

    const late = tickets.issue("device", 1_000)!;
    expect(tickets.redeem(late.ticket, 61_000)).toBeUndefined();

    const guessed = tickets.issue("device", 1_000)!;
    const [prefix, id] = guessed.ticket.split(".");
    expect(tickets.redeem(`${prefix}.${id}.wrong`, 2_000)).toBeUndefined();
    // A wrong secret spends nothing.
    expect(tickets.redeem(guessed.ticket, 2_000)).toBe("device");
  });

  it("holds at most 16 open per device, so one cannot starve the others", () => {
    const tickets = new TicketStore();
    for (let n = 0; n < 16; n += 1) expect(tickets.issue("greedy", 0)).toBeDefined();
    expect(tickets.issue("greedy", 0)).toBeUndefined();
    expect(tickets.issue("other", 0)).toBeDefined();
    // Expired ones make room again.
    expect(tickets.issue("greedy", 60_000)).toBeDefined();
  });
});

describe("the replay guard (security.md D1366)", () => {
  it("refuses a jti seen within its window, per key, and fills per key only", () => {
    const guard = new ReplayGuard(0);
    expect(guard.admit("key-a", "1", 100, 100)).toBe("ok");
    expect(guard.admit("key-a", "1", 100, 200)).toBe("replay");
    expect(guard.admit("key-b", "1", 200, 200)).toBe("ok");
    // Past its window (iat + 300 s + 5 s of skew) a jti is forgotten.
    expect(guard.admit("key-a", "1", 100, 406)).toBe("ok");
    for (let n = 0; n < 1_000; n += 1) guard.admit("key-a", `n${n}`, 500, 500);
    expect(guard.admit("key-a", "full", 500, 500)).toBe("busy");
    expect(guard.admit("key-b", "2", 500, 500)).toBe("ok");
    // Once the full key's proofs could no longer be fresh, it takes proofs again.
    expect(guard.admit("key-a", "later", 806, 806)).toBe("ok");
  });

  it("refuses a proof made before the guard began, less the skew", () => {
    const guard = new ReplayGuard(1_000);
    expect(guard.admit("key", "a", 994, 1_000)).toBe("time_window");
    expect(guard.admit("key", "b", 995, 1_000)).toBe("ok");
  });
});
