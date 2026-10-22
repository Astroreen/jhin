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

test("D866–D868: the Lineage section lists delegated work and stops it", async ({ page }, info) => {
  const parentId = await startThread(page, "lineage parent");
  // A thread without related threads shows no Lineage section (D866).
  const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
  await toggle.click();
  await expect(page.getByRole("region", { name: "Thread details" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Thread details" }).getByText("Lineage", { exact: true }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  const held = await node.client().call<{ childThreadId: string }>("tasks.delegate", {
    task: "/hold digging",
    title: "Digger",
    parentThreadId: parentId,
  });
  const script = `export const meta = { name: 'tour', description: 'Hold two agents', phases: [{ title: 'Wait' }] }
phase('Wait')
return await parallel(['east', 'west'].map((place) => () => agent('/hold ' + place, { label: place })))`;
  await node.client().call("workflows.run", { script, parentThreadId: parentId });
  await expect(page.getByRole("region", { name: "Workflow started: tour" })).toContainText(
    "2 agents · 2 working",
  );

  await toggle.click();
  const details = page.getByRole("region", { name: "Thread details" });
  const related = details.getByRole("list", { name: "Related threads" });
  await expect(related.getByRole("button", { name: "Open Digger chat" })).toContainText("Running");
  await related.getByRole("button", { name: "Expand tour" }).click();
  await expect(related.getByRole("button", { name: "Collapse Wait phase, running" })).toContainText(
    "0/2 agents",
  );
  await expect(related.getByRole("button", { name: "Open east chat" })).toBeVisible();
  await shot(page, info, "delegation-lineage");

  await related.getByRole("button", { name: "Open Digger chat" }).hover();
  await related.getByRole("button", { name: "Stop subagent Digger" }).click();
  await expect(related.getByRole("button", { name: "Open Digger chat" })).toContainText("Stopped");

  await related.getByRole("button", { name: "tour Running" }).hover();
  await related.getByRole("button", { name: "Stop workflow tour" }).click();
  await expect(related.getByRole("button", { name: "tour Stopped" })).toBeVisible();
  // A phase no longer running folds, as in T3.
  await related.getByRole("button", { name: "Expand Wait phase, stopped" }).click();
  await expect(related.getByRole("button", { name: "Open west chat" })).toContainText("Stopped");

  // The child's own panel leads back to its parent.
  await related.getByRole("button", { name: "Open Digger chat" }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(held.childThreadId)));
  await page.getByRole("button", { name: "Toggle thread details panel" }).click();
  const back = page
    .getByRole("region", { name: "Thread details" })
    .getByRole("button", { name: "lineage parent Stopped" });
  await back.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(parentId)));
});

test("D879–D880: a subagent the agent runs itself is a child thread that runs on its own", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/subagent survey the land");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(
    "Ran a subagent for survey the land",
  );
  const row = page.getByRole("button", { name: "Open survey the land", exact: true });
  await expect(row).toContainText("Completed");
  await expect(threadRow(page, "survey the land")).toHaveCount(0);

  await page.getByRole("button", { name: "Toggle thread details panel" }).click();
  const related = page
    .getByRole("region", { name: "Thread details" })
    .getByRole("list", { name: "Related threads" });
  await expect(related.getByRole("button", { name: "Open survey the land chat" })).toContainText(
    "Done",
  );
  await page.keyboard.press("Escape");

  await row.click();
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: survey the land");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(page.getByText("Runs on its own")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "subagent: Completed" })).toBeAttached();
  await shot(page, info, "provider-subagent");
  await page.getByRole("button", { name: "Open parent" }).click();
  await expect(
    page.getByRole("button", { name: "Open survey the land", exact: true }),
  ).toBeVisible();
});
