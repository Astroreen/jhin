import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { threadRow } from "./support/ui.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

async function startThread(page: Page, text: string): Promise<string> {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(`Echo: ${text}`);
  const threadId = /[#&]t=([^&]+)/.exec(page.url())?.[1];
  if (threadId === undefined) throw new Error(`no thread in ${page.url()}`);
  return decodeURIComponent(threadId);
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D862–D865: delegated work shows in its turn and opens its thread, which the sidebar hides", async ({
  page,
}, info) => {
  const parentId = await startThread(page, "coordinate");
  await node.client().call("tasks.delegate", { task: "look around", parentThreadId: parentId });
  const subagent = page.getByRole("button", { name: "Open look around" });
  // The row follows the task to its result.
  await expect(subagent).toContainText("Echo: look around");
  await expect(threadRow(page, "coordinate")).toBeVisible();
  await expect(threadRow(page, "look around")).toHaveCount(0);

  const script = `export const meta = { name: 'survey', description: 'Look at two places', phases: [{ title: 'Look' }] }
phase('Look')
return await parallel(['north', 'south'].map((place) => () => agent('look ' + place, { label: place })))`;
  await node.client().call("workflows.run", { script, parentThreadId: parentId });
  const workflow = page.getByRole("region", { name: "Workflow started: survey" });
  await expect(workflow).toContainText("Look at two places");
  await expect(workflow).toContainText("2 agents · 2 done");
  await expect(workflow.getByRole("region", { name: "Look phase" })).toContainText("2/2");
  await expect(workflow.getByRole("button", { name: "Open north" })).toContainText(
    "Echo: look north",
  );

  await node.client().call("orchestration.launch", {
    title: "Side quest",
    callerThreadId: parentId,
  });
  await expect(page.getByText("Created thread · Side quest")).toBeVisible();
  // A delegated task tells its parent, not the user.
  await expect(page.getByText("Thread completed")).toHaveCount(0);
  await shot(page, info, "delegation-rows");

  await subagent.click();
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: look around");
  expect(page.url()).not.toContain(encodeURIComponent(parentId));
});
