import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { hideThreadDetails, showThreadDetails, threadRow } from "./support/ui.ts";

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
  const subagent = page.getByRole("button", { name: "Open look around", exact: true });
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

  // D1162: the row's hover card tells the status and the result.
  await subagent.hover();
  const card = page.getByRole("group", { name: "Subagent details" });
  await expect(card).toContainText("completed");
  await expect(card).toContainText("Echo: look around");
  await shot(page, info, "subagent-hover-card");

  await subagent.click();
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: look around");
  expect(page.url()).not.toContain(encodeURIComponent(parentId));
});

test("D866–D868: the Lineage section lists delegated work and stops it", async ({ page }, info) => {
  const parentId = await startThread(page, "lineage parent");
  // A thread without related threads shows no Lineage section (D866).
  // Beside the wide chat its card stays out of the way while it has nothing to show (D1350).
  await expect(page.getByRole("button", { name: "Toggle thread details panel" })).toHaveAttribute(
    "data-details-presentation",
    "inline",
  );
  // Room for it, but nothing to show: the toggle works the popover instead.
  await expect(page.getByRole("button", { name: "Toggle thread details panel" })).toHaveAttribute(
    "data-details-effective",
    "popover",
  );
  await expect(page.getByRole("region", { name: "Thread details" })).toBeHidden();
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

  const details = await showThreadDetails(page);
  const related = details.getByRole("list", { name: "Related threads" });
  await expect(related.getByRole("button", { name: "Open Digger chat" })).toContainText("Running");
  // D1163: the title counts the subagents that run.
  await expect(details.getByRole("heading", { name: "Lineage · 3 running" })).toBeVisible();
  await related.getByRole("button", { name: "Expand tour" }).click();
  await expect(related.getByRole("button", { name: "Collapse Wait phase, running" })).toContainText(
    "0/2 agents",
  );
  await expect(related.getByRole("button", { name: "Open east chat" })).toBeVisible();
  await shot(page, info, "delegation-lineage");

  await related.getByRole("button", { name: "Open Digger chat" }).hover();
  await related.getByRole("button", { name: "Stop subagent Digger" }).click();
  await expect(related.getByRole("button", { name: "Open Digger chat" })).toContainText("Stopped");
  await expect(details.getByRole("heading", { name: "Lineage · 2 running" })).toBeVisible();

  await related.getByRole("button", { name: "tour Running" }).hover();
  await related.getByRole("button", { name: "Stop workflow tour" }).click();
  await expect(related.getByRole("button", { name: "tour Stopped" })).toBeVisible();
  // A phase no longer running folds, as in T3.
  await related.getByRole("button", { name: "Expand Wait phase, stopped" }).click();
  await expect(related.getByRole("button", { name: "Open west chat" })).toContainText("Stopped");

  // The child's own panel leads back to its parent.
  await related.getByRole("button", { name: "Open Digger chat" }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(held.childThreadId)));
  const back = (await showThreadDetails(page)).getByRole("button", {
    name: "lineage parent Stopped",
  });
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

  const related = (await showThreadDetails(page)).getByRole("list", { name: "Related threads" });
  await expect(related.getByRole("button", { name: "Open survey the land chat" })).toContainText(
    "Done",
  );
  await hideThreadDetails(page);

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

test("D1164–D1167: a subagent in the background works past its turn and stops from the panel", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/subagent-bg dig deep");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(
    "Started dig deep in the background",
  );
  // The turn ended; its subagent still runs.
  const row = page.getByRole("button", { name: "Open dig deep", exact: true });
  await expect(row).toContainText("Running");
  // D1343, D1344: its hover card tells what it is doing now.
  await row.hover();
  const card = page.getByRole("group", { name: "Subagent details" });
  await expect(card).toContainText("running");
  await expect(card).toContainText("Working on dig deep");
  await shot(page, info, "subagent-progress");
  await page.mouse.move(0, 0);
  await expect(card).toBeHidden();

  const details = await showThreadDetails(page);
  const related = details.getByRole("list", { name: "Related threads" });
  const child = related.getByRole("button", { name: "Open dig deep chat" });
  await expect(child).toContainText("Running");
  await child.hover();
  await shot(page, info, "provider-subagent-stop");
  await related.getByRole("button", { name: "Stop subagent dig deep" }).click();
  await expect(child).toContainText("Stopped");
  await page.keyboard.press("Escape");
  await expect(row).toContainText("Stopped");

  // Its work after the turn is in its thread.
  await row.click();
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: dig deep");
});

test("D1161: subagents started one after another are one row", async ({ page }, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/subagent north; south; east; west");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Ran 4 subagents");
  const group = page.getByRole("button", { name: "4 subagents" });
  await expect(group).toContainText("4 done");
  await expect(group).toContainText("+1");
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Open north", exact: true })).toHaveCount(0);

  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  for (const place of ["north", "south", "east", "west"]) {
    await expect(page.getByRole("button", { name: `Open ${place}`, exact: true })).toContainText(
      "Completed",
    );
  }
  await shot(page, info, "subagent-group");
  await page.getByRole("button", { name: "Open south", exact: true }).click();
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: south");
});
