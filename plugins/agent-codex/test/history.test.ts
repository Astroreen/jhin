import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, stopAll, until, type Client, type Scenario } from "./support.ts";

afterEach(stopAll);

/** Sends `text` and waits for its turn to complete; returns its turn id. */
async function turn(client: Client, threadId: string, text: string, count: number) {
  const done = until(client, threadId, "agent.turn.completed", count);
  await client.call("threads.send", { threadId, text });
  const events = await done;
  return String(
    (
      events.filter((event) => event.type === "agent.turn.started").at(-1)!.payload as {
        turnId: string;
      }
    ).turnId,
  );
}

const sentText = (call: { params?: Record<string, unknown> } | undefined) =>
  ((call?.params?.["input"] as { text?: string }[] | undefined) ?? [])[0]?.text;

async function threadWithTwoTurns(scenario: Scenario = {}) {
  const fake = fakeCodex(scenario);
  const { client } = await node(fake);
  const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
  const first = await turn(client, thread.id, "first", 1);
  await turn(client, thread.id, "second", 2);
  return { fake, client, thread, first };
}

describe("jhin.agent-codex: rollback and fork (D1147, D1148)", () => {
  it("reverts the Codex thread before the turns a rollback dropped", async () => {
    const { fake, client, thread, first } = await threadWithTwoTurns();
    await client.call("threads.rollback", { threadId: thread.id, turnId: first });
    await turn(client, thread.id, "third", 3);
    // Codex's second turn goes from its own thread; no transcript is needed.
    expect(fake.received("thread/revert").map((call) => call.params)).toEqual([
      { threadId: "codex-thread-1", beforeTurnId: "turn-2" },
    ]);
    expect(sentText(fake.received("turn/start").at(-1))).toBe("third");
    expect(fake.received("thread/start")).toHaveLength(1);
  });

  it("starts a new Codex thread with the transcript when Codex cannot revert", async () => {
    const { fake, client, thread, first } = await threadWithTwoTurns({
      errors: { "thread/revert": [{ message: "legacy history cannot be reverted" }] },
    });
    await client.call("threads.rollback", { threadId: thread.id, turnId: first });
    await turn(client, thread.id, "third", 3);
    expect(fake.received("thread/start")).toHaveLength(2);
    const last = fake.received("turn/start").at(-1)!;
    expect(last.params?.["threadId"]).toBe("codex-thread-2");
    const text = sentText(last) ?? "";
    expect(text).toContain("first");
    expect(text).not.toContain("second");
    expect(text.endsWith("third")).toBe(true);
  });

  it("forks the parent's Codex thread at the turn a fork was made at", async () => {
    const { fake, client, thread, first } = await threadWithTwoTurns();
    const fork = await client.call<{ id: string }>("threads.fork", {
      threadId: thread.id,
      turnId: first,
    });
    // The fork's turns started so far are its inherited one; its own is the next.
    await turn(client, fork.id, "in the fork", 2);
    expect(fake.received("thread/fork").map((call) => call.params)).toEqual([
      expect.objectContaining({ threadId: "codex-thread-1", lastTurnId: "turn-1" }),
    ]);
    const last = fake.received("turn/start").at(-1)!;
    expect(last.params?.["threadId"]).toBe("codex-fork-1");
    expect(sentText(last)).toBe("in the fork");

    // A rollback in the fork reverts into what it inherited.
    const own = await turn(client, fork.id, "again", 3);
    expect(own).toEqual(expect.any(String));
    await client.call("threads.rollback", { threadId: fork.id, turnId: first });
    await turn(client, fork.id, "after", 4);
    expect(fake.received("thread/revert").at(-1)?.params).toEqual({
      threadId: "codex-fork-1",
      beforeTurnId: "turn-3",
    });
  });
});
