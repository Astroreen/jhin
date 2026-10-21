// Civilization mode's agents (docs/plans/agents.md, A1: D614): the roster, an
// agent's page with its generations read without a composer, stop and resume.
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

test("D614: the roster and an agent's page, read only, with stop, resume and a new generation", async ({
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
  // Threads mode never lists a generation (D741).
  await expect(page.getByText("Builder #1")).toHaveCount(0);

  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  const roster = page.getByRole("region", { name: "Agents" });
  await expect(roster.getByRole("button", { name: /^Analyst, Idle/ })).toBeVisible();
  await expect(roster.getByText("Builds slices and proves them")).toBeVisible();

  await roster.getByRole("button", { name: /^Builder,/ }).click();
  const agentPage = page.locator("[data-agent-page=builder]");
  await expect(agentPage.getByRole("heading", { name: "Builder" })).toBeVisible();
  await expect(agentPage.getByText("Idle", { exact: true })).toBeVisible();
  const generations = agentPage.getByRole("navigation", { name: "Generations" });
  await expect(generations.getByRole("button", { name: /Generation 1 · current/ })).toBeVisible();
  // The generation's conversation, readable, and nothing to type into (D741).
  const transcript = agentPage.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("hello there", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Echo: hello there")).toBeVisible();
  await expect(agentPage.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("agent-page.png") });

  await agentPage.getByRole("button", { name: "Stop" }).click();
  await expect(agentPage.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(roster.getByRole("button", { name: /^Builder, Stopped/ })).toBeVisible();
  await expect(agentPage.getByRole("button", { name: "New generation" })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("agent-stopped.png") });

  await agentPage.getByRole("button", { name: "Resume" }).click();
  await expect(agentPage.getByText("Idle", { exact: true })).toBeVisible();
  await agentPage.getByRole("button", { name: "New generation" }).click();
  await expect(generations.getByRole("button", { name: /Generation 2 · current/ })).toBeVisible();
  // The earlier generation stays readable.
  await generations.getByRole("button", { name: /Generation 1/ }).click();
  await expect(transcript.getByText("Echo: hello there")).toBeVisible();
});
