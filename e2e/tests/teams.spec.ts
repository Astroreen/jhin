// Teams in Civilization mode (docs/plans/agents.md#a5, D689, D691).
import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode({
    config: {
      "jhin.teams": {
        teams: {
          workshop: {
            title: "Workshop",
            lead: "lead",
            culture: "We ask before we guess.",
            agents: {
              lead: { role: "Talks to the owner and plans", runtime: "jhin.agent-fake" },
              builder: { role: "Builds slices", runtime: "jhin.agent-fake" },
            },
          },
        },
      },
    },
  });
});
test.afterAll(async () => {
  await node.stop();
});

test("D689, D691: a team is started, stopped and talked to through its lead in Civilization mode", async ({
  page,
}, info) => {
  const client = node.client();
  // Civilization mode is offered once the node has a defined agent (D747).
  await client.call("teams.up", { teamId: "workshop" });

  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  const teams = page.getByRole("region", { name: "Teams" });
  await teams.getByRole("button", { name: /Workshop/ }).click();

  const team = page.getByRole("region", { name: "Team Workshop" });
  await expect(team.getByRole("heading", { name: "Workshop" })).toBeVisible();
  const agents = team.getByRole("list", { name: "Agents" });
  await expect(agents.getByText("lead@workshop")).toBeVisible();
  await expect(agents.getByText("builder@workshop")).toBeVisible();
  await expect(agents.getByText("Idle")).toHaveCount(2);
  await expect(team.getByText("We ask before we guess.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("team-up.png") });

  // The owner talks to the lead in the Lead view, the one composer of the mode (C1, D1062).
  await team.getByRole("button", { name: "Talk to the lead" }).click();
  const leadView = page.getByRole("region", { name: "Lead", exact: true });
  await leadView.getByRole("textbox", { name: "Message to the lead" }).fill("Plan slice 3.");
  await leadView.getByRole("textbox", { name: "Message to the lead" }).press("Enter");
  const conversation = leadView.getByRole("log", { name: "Conversation with the lead" });
  await expect(conversation.getByRole("article", { name: "You" })).toHaveText("Plan slice 3.");
  // The fake lead echoes what it was asked: its answer is the turn's last message (D624).
  await expect(conversation.getByRole("article", { name: "Lead" })).toContainText("Plan slice 3.");
  await page.screenshot({ path: info.outputPath("lead-console.png") });
  const lead = await client.call<{ generations: unknown[] }>("agents.get", {
    agentId: "workshop-lead",
  });
  expect(lead.generations).toHaveLength(1);
  // The conversation is the node's record, read back as the CLI and MCP read it (D1061).
  const read = await client.call<{ entries: { answer?: string }[] }>("agents.conversation", {
    with: "lead@workshop",
  });
  expect(read.entries).toHaveLength(1);
  expect(read.entries[0]?.answer).toContain("Plan slice 3.");

  await teams.getByRole("button", { name: /Workshop/ }).click();
  await team.getByRole("button", { name: "Stop team" }).click();
  await expect(agents.getByText("Stopped")).toHaveCount(2);
  await expect(team.getByRole("button", { name: "Start team" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("team-stopped.png") });
  const stopped = await client.call<{ stoppedAt?: string }>("agents.get", {
    agentId: "workshop-builder",
  });
  expect(stopped.stoppedAt).toBeDefined();

  await team.getByRole("button", { name: "Start team" }).click();
  await expect(agents.getByText("Idle")).toHaveCount(2);
});
