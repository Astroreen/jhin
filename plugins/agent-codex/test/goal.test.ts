import { afterEach, describe, expect, it } from "vite-plus/test";

import { CODEX_AGENT_ID } from "../src/index.ts";
import { fakeCodex, node, payloads, stopAll, until, type Step } from "./support.ts";

afterEach(stopAll);

const message = (turnId: string, itemId: string, text: string): Step => ({
  notify: "item/completed",
  params: { threadId: "$thread", turnId, item: { type: "agentMessage", id: itemId, text } },
});

describe("jhin.agent-codex: /goal (D1149)", () => {
  it("sets a goal and follows the turns Codex starts for it until it is complete", async () => {
    const fake = fakeCodex({
      turns: [
        [
          message("$turn", "m1", "Working on it"),
          // The goal is active (Jhin set it after turn/start) before this turn completes.
          { waitFor: "thread/goal/set", count: 2 },
          { complete: "completed" },
          // Codex goes on with the goal by itself.
          { notify: "turn/started", params: { threadId: "$thread", turn: { id: "goal-2" } } },
          message("goal-2", "m2", "Tests pass now"),
          {
            notify: "thread/goal/updated",
            params: {
              threadId: "$thread",
              goal: { objective: "Fix the tests", status: "complete", tokensUsed: 1200 },
            },
          },
          {
            notify: "turn/completed",
            params: { threadId: "$thread", turn: { id: "goal-2", status: "completed" } },
          },
        ],
      ],
    });
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const done = until(client, thread.id, "agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "/goal Fix the tests" });
    const events = await done;
    // Codex got the objective alone, paused until its turn ran, then active.
    expect(fake.received("thread/goal/set").map((call) => call.params)).toEqual([
      { threadId: "codex-thread-1", objective: "Fix the tests", status: "paused" },
      { threadId: "codex-thread-1", status: "active" },
    ]);
    const input = (fake.received("turn/start")[0]?.params?.["input"] ?? []) as { text: string }[];
    expect(input[0]?.text).toBe("Fix the tests");
    expect(payloads(events, "agent.item.completed").map((item) => item["text"])).toEqual([
      "Working on it",
      "Tests pass now",
    ]);
    expect(
      payloads(events, "agent.goal.updated").map(
        (update) => (update["goal"] as { status: string } | null)?.status,
      ),
    ).toEqual(["paused", "active", "complete"]);
  });

  it("answers /goal, /goal pause and /goal clear without a turn of Codex", async () => {
    const fake = fakeCodex({});
    const { client } = await node(fake);
    const thread = await client.call<{ id: string }>("threads.create", { agentId: CODEX_AGENT_ID });
    const replies: string[] = [];
    for (const [index, text] of ["/goal", "/goal pause", "/goal clear"].entries()) {
      const done = until(client, thread.id, "agent.turn.completed", index + 1);
      await client.call("threads.send", { threadId: thread.id, text });
      replies.push(String(payloads(await done, "agent.item.completed").at(-1)?.["text"]));
    }
    expect(replies).toEqual(["No goal is set.", "No goal is set.", "No goal to clear."]);
    expect(fake.received("turn/start")).toHaveLength(0);
    const offered = await client.call<{ commands: { name: string }[] }>("agents.commands", {
      projectId: "scratch",
      agentId: CODEX_AGENT_ID,
    });
    expect(offered.commands.map((command) => command.name)).toContain("goal");
  });
});
