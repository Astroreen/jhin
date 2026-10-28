import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, stopAll } from "./support.ts";

afterEach(stopAll);

const CREDIT_EXPIRES = Math.floor(Date.parse("2030-02-01T00:00:00Z") / 1000);
const rateLimits = {
  rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300 } },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [{ status: "available", expiresAt: CREDIT_EXPIRES }],
  },
};

describe("jhin.agent-codex: reset credits (t3-parity.md D1656)", () => {
  it("redeems one with an idempotency key, answers Codex's outcome and reads the limits again", async () => {
    const fake = fakeCodex({ rateLimits });
    const { client } = await node(fake);
    expect(await client.call("agents.usage-limits", { agentId: CODEX_AGENT_ID })).toMatchObject({
      usageLimits: { resetCredits: { availableCount: 1 } },
    });
    expect(fake.received("account/rateLimits/read")).toHaveLength(1);

    expect(await client.call("agents.reset-credit.consume", { agentId: CODEX_AGENT_ID })).toEqual({
      outcome: "reset",
    });
    const [consumed] = fake.received("account/rateLimitResetCredit/consume");
    expect(consumed!.params).toEqual({ idempotencyKey: expect.any(String) });
    // Read again before the answer, so the page's next look shows the cleared windows without
    // another read.
    expect(fake.received("account/rateLimits/read")).toHaveLength(2);
    await client.call("agents.usage-limits", { agentId: CODEX_AGENT_ID });
    expect(fake.received("account/rateLimits/read")).toHaveLength(2);
  });

  it("keeps the key for the press after a lost answer, and takes a new one after an outcome", async () => {
    const fake = fakeCodex({
      rateLimits,
      resetCreditOutcome: "alreadyRedeemed",
      errors: {
        "account/rateLimitResetCredit/consume": [{ code: -32000, message: "connection reset" }],
      },
    });
    const { client } = await node(fake);
    await expect(
      client.call("agents.reset-credit.consume", { agentId: CODEX_AGENT_ID }),
    ).rejects.toMatchObject({ message: "Codex could not redeem the reset credit." });
    // A failed redemption changed nothing to read again.
    expect(fake.received("account/rateLimits/read")).toHaveLength(0);
    expect(await client.call("agents.reset-credit.consume", { agentId: CODEX_AGENT_ID })).toEqual({
      outcome: "alreadyRedeemed",
    });
    await client.call("agents.reset-credit.consume", { agentId: CODEX_AGENT_ID });
    const keys = fake
      .received("account/rateLimitResetCredit/consume")
      .map((request) => request.params?.["idempotencyKey"]);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
