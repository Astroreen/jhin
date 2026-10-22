// Health in Civilization mode (docs/plans/agents.md#a7, D722, D724, D725, D731).
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode({
    config: {
      "jhin.agents": { agents: { lead: { role: "Leads the team", runtime: "jhin.agent-fake" } } },
      "jhin.health": { ceremony: { ratio: 1, minCeremony: 2 } },
    },
  });
});
test.afterAll(async () => {
  await node.stop();
});

test("D722, D724, D725, D731: ceremony without progress raises a warning the lead analyses, with its events", async ({
  page,
}, info) => {
  const client = node.client();
  const lead = await client.call<{ address: string }>("agents.get", { agentId: "lead" });
  const dir = Path.join(node.home, "doghouse");
  Fs.mkdirSync(dir, { recursive: true });
  const project = await client.call<{ id: string }>("projects.create", { path: dir });
  const mission = await client.call<{ id: string }>("missions.create", {
    projectId: project.id,
    title: "Doghouse",
    outcome: "The dog sleeps dry.",
  });
  await client.call("slices.create", {
    missionId: mission.id,
    title: "Floor",
    spec: "The floor holds the dog.",
    assignee: lead.address,
  });

  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  const health = page.getByRole("region", { name: "Health" });
  await expect(health.getByText("No warnings.")).toBeVisible();

  // Two messages to the lead and no progress: ceremony crosses the threshold of its mission.
  await client.call("agents.send", { to: lead.address, body: "Is the floor done?" });
  await client.call("agents.send", { to: lead.address, body: "Please prove it again." });

  const entry = health.getByRole("button", { name: /Ceremony outgrows progress/ });
  await expect(entry).toBeVisible();
  await entry.click();
  const warning = page.getByRole("region", { name: "Health warning" });
  await expect(warning.getByRole("heading", { name: "Ceremony outgrows progress" })).toBeVisible();
  await expect(
    warning.getByText("2 ceremony against 0 progress in 24h (warns at 2)", { exact: true }),
  ).toBeVisible();
  // The agent with the context (the slice's assignee) was asked, never a random one.
  const analysis = warning.getByRole("region", { name: "Analysis" });
  await expect(analysis.getByText(lead.address, { exact: true })).toBeVisible();
  // The fake runtime answers with what it was asked.
  await expect(analysis.getByText(/^Echo: .*Health warning/s)).toBeVisible();
  await expect(analysis.getByText("Waiting for the analyst…")).toBeHidden();

  // The drill-down: the messages behind it, each opening to its record.
  const events = warning.getByRole("region", { name: "Events behind it" });
  await expect(events.getByText(/→ .*: Is the floor done\?/)).toBeVisible();
  await expect(events.getByText(/→ .*: Please prove it again\./)).toBeVisible();
  const first = events.getByRole("listitem").filter({ hasText: "Is the floor done?" });
  await first.getByText(/→ .*: Is the floor done\?/).click();
  await expect(first.getByText(/agents\/messages#\d+ agents\.message\.delivered/)).toBeVisible();
  await expect(first.getByText(/"traceId"/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("health-warning.png") });

  await warning.getByRole("button", { name: "Dismiss" }).click();
  await expect(warning.getByText("Dismissed")).toBeVisible();
  await expect(health.getByText("No warnings.")).toBeVisible();

  await health.getByRole("button", { name: "Ceremony and progress" }).click();
  const overview = page.getByRole("region", { name: "Ceremony and progress" });
  await expect(overview.getByRole("cell", { name: "Mission Doghouse" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("health-overview.png") });
});
