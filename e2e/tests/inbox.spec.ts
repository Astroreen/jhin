// The owner's inbox in Civilization mode (docs/plans/agents.md#a2, D626, D630).
import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode({
    config: {
      "jhin.agents": { agents: { lead: { role: "Leads the team", runtime: "jhin.agent-fake" } } },
    },
  });
});
test.afterAll(async () => {
  await node.stop();
});

test("D626, D630: an agent's ask to the owner waits in the inbox and the answer goes back", async ({
  page,
}, info) => {
  const client = node.client();
  const lead = await client.call<{ address: string }>("agents.get", { agentId: "lead" });
  const nodeId = /^jhin:\/\/([^/]+)\//.exec(lead.address)![1]!;

  await page.goto(`${node.ui}#token=${node.token}`);
  await page
    .getByRole("group", { name: "Modes" })
    .getByRole("button", { name: "Civilization" })
    .click();
  const inbox = page.getByRole("region", { name: "Inbox" });
  await expect(inbox.getByText("Nothing waits for you.")).toBeVisible();

  // The lead asks the owner (the owner's token may send for it, D622).
  const asked = await client.call<{ status: string; message: { messageId: string } }>(
    "agents.ask",
    { to: `jhin://${nodeId}/owner`, from: lead.address, question: "May I merge slice 3?" },
  );
  expect(asked.status).toBe("pending");

  const entry = inbox.getByRole("button", { name: /May I merge slice 3\?/ });
  await expect(entry).toBeVisible();
  await entry.click();
  const question = page.getByRole("region", { name: "Question" });
  await expect(
    question.getByRole("heading", { name: `Question from lead@${nodeId.slice(0, 8)}` }),
  ).toBeVisible();
  await expect(question.getByText(lead.address)).toBeVisible();
  await page.screenshot({ path: info.outputPath("inbox-question.png") });

  await question.getByRole("textbox", { name: "Your answer" }).fill("Yes, after the release.");
  await question.getByRole("button", { name: "Send answer" }).click();
  await expect(inbox.getByText("Nothing waits for you.")).toBeVisible();
  await expect(page.getByText("Nothing to answer")).toBeVisible();

  const answered = await client.call<{ items: { status: string; answer?: string }[] }>(
    "agents.inbox.list",
    { status: "answered" },
  );
  expect(answered.items).toEqual([
    expect.objectContaining({ status: "answered", answer: "Yes, after the release." }),
  ]);
  // The answer woke the lead: its first generation got it as a message.
  const generations = await client.call<{ threadId: string }[]>("agents.generations", {
    agentId: "lead",
  });
  expect(generations).toHaveLength(1);
});
