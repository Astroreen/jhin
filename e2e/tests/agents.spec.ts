// Civilization mode's agents (docs/plans/agents.md, A1: D614–D617): the
// roster, an agent's page with its generations read without a composer, stop
// and resume.
import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode({
    config: {
      "jhin.agents": {
        agents: {
          builder: {
            title: "Builder",
            role: "Builds slices and proves them",
            runtime: "jhin.agent-fake",
          },
          analyst: { title: "Analyst", role: "Reads the code first", runtime: "jhin.agent-fake" },
        },
      },
    },
  });
});
test.afterAll(async () => {
  await node.stop();
});

test("D614: the roster and an agent's page, read only, with stop and resume", async ({
  page,
}, info) => {
  // The builder's first generation has a turn; the analyst has none yet.
  const client = node.client();
  const { generation } = await client.call<{ generation: { threadId: string } }>("agents.rotate", {
    agentId: "builder",
    reason: "first slice",
  });
  await client.call("threads.send", { threadId: generation.threadId, text: "hello there" });

  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page.getByRole("button", { name: "Start a thread" })).toBeVisible();
  // Threads mode shows no agent and no generation (D741).
  await expect(page.getByText("Builder #1")).toHaveCount(0);
  await expect(page.getByText("Builds slices and proves them")).toHaveCount(0);

  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  const roster = page.getByRole("region", { name: "Agents" });
  // Grouped by home project: both live in the scratch project (D617).
  const project = roster.getByRole("group").first();
  await expect(project.getByRole("button", { name: /^Analyst, Idle/ })).toBeVisible();
  await expect(roster.getByText("Builds slices and proves them")).toBeVisible();
  await page.screenshot({ path: info.outputPath("roster.png") });

  await roster.getByRole("button", { name: /^Builder,/ }).click();
  await expect(page).toHaveURL(/[#&]p=agent(&|$)/);
  const agentPage = page.locator("[data-agent-page=builder]");
  await expect(agentPage.getByRole("heading", { name: "Builder" })).toBeVisible();
  await expect(agentPage.getByText("Idle", { exact: true })).toBeVisible();
  const generations = agentPage.getByRole("navigation", { name: "Generations" });
  await expect(generations.getByRole("button", { name: /Generation 1 · current/ })).toBeVisible();
  // The generation's conversation, readable, and nothing to type into (D741).
  const transcript = agentPage.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("hello there", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Echo: hello there")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("agent-page.png") });

  await agentPage.getByRole("button", { name: "Stop" }).click();
  await expect(agentPage.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(roster.getByRole("button", { name: /^Builder, Stopped/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("agent-stopped.png") });
  // A stopped agent takes no new generation (D612).
  await expect(client.call("agents.rotate", { agentId: "builder" })).rejects.toMatchObject({
    code: "AGENT_STOPPED",
  });

  await agentPage.getByRole("button", { name: "Resume" }).click();
  await expect(agentPage.getByText("Idle", { exact: true })).toBeVisible();
  // A generation started elsewhere shows up live, and the earlier one stays readable.
  await client.call("agents.rotate", { agentId: "builder", reason: "context spent" });
  await expect(generations.getByRole("button", { name: /Generation 2 · current/ })).toBeVisible();
  await expect(transcript.getByText("No turns yet.")).toBeVisible();
  await generations.getByRole("button", { name: /Generation 1/ }).click();
  await expect(page).toHaveURL(/[#&]s=builder(%2F|\/)1(&|$)/);
  await expect(transcript.getByText("Echo: hello there")).toBeVisible();
});
