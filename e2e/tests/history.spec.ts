import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { hideThreadDetails, showThreadDetails } from "./support/ui.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

/** A screenshot of the page in the report. */
async function shoot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

/** Starts a thread and sends `texts` one after another, each answered before the next. */
async function thread(page: Page, ...texts: string[]) {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  const log = page.getByRole("log", { name: "Messages" });
  for (const [index, text] of texts.entries()) {
    await message.fill(text);
    await message.press("Enter");
    await expect(log.getByRole("article", { name: "Agent" })).toHaveCount(index + 1);
    await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveAttribute(
      "aria-busy",
      "false",
    );
  }
  return { message, log };
}

test("edits a sent message from here: the chat rewinds and the message returns to the composer", async ({
  page,
}, info) => {
  const { message, log } = await thread(page, "first question", "second question", "third");

  const second = log.getByRole("article", { name: "You" }).nth(1);
  await second.hover();
  await shoot(page, info, "hover-row");
  await log.getByRole("button", { name: "Edit from here" }).nth(1).click();
  const dialog = page.getByRole("alertdialog", { name: "Edit from here?" });
  await expect(dialog).toContainText(
    "Rewind chat to before this message. Your prompt and attachments return to the composer.",
  );
  await shoot(page, info, "edit-from-here");
  await dialog.getByRole("button", { name: "Revert and keep changes" }).click();

  // The message and everything after it are gone; its text waits in the composer.
  await expect(log.getByRole("article", { name: "You" })).toHaveText(["first question"]);
  await expect(log.getByRole("article", { name: "Agent" })).toHaveText(["Echo: first question"]);
  await expect(message).toHaveText("second question");

  await message.fill("second question, edited");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText(
    "Echo: second question, edited",
  );
  // Still so after a reload: the node dropped the turns, not the page.
  await page.reload();
  await expect(log.getByRole("article", { name: "You" })).toHaveText([
    "first question",
    "second question, edited",
  ]);
  await shoot(page, info, "edited");
});

test("cancelling Edit from here leaves the chat and the composer as they were", async ({
  page,
}) => {
  const { message, log } = await thread(page, "keep me");
  await message.fill("a draft");
  await log.getByRole("article", { name: "You" }).hover();
  await log.getByRole("button", { name: "Edit from here" }).click();
  await page
    .getByRole("alertdialog", { name: "Edit from here?" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(log.getByRole("article", { name: "You" })).toHaveText(["keep me"]);
  await expect(message).toHaveText("a draft");
});

test("retries a failed turn in its place, and regenerates the latest response", async ({
  page,
}, info) => {
  const { message, log } = await thread(page, "hello");
  await message.fill("/fail on purpose");
  await message.press("Enter");
  await expect(page.getByText("Turn failed")).toBeVisible();
  const turns = log.locator("[data-turn]");
  const failed = await turns.last().getAttribute("data-turn");

  // Retry runs the failed turn again instead of sending its message a second time.
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(turns.last()).not.toHaveAttribute("data-turn", failed!);
  await expect(page.getByText("Turn failed")).toHaveCount(1);
  await expect(log.getByRole("article", { name: "You" })).toHaveText(["hello", "/fail on purpose"]);

  await message.fill("again");
  await message.press("Enter");
  const last = log.getByRole("article", { name: "Agent" }).last();
  await expect(last).toHaveText("Echo: again");
  await expect(last).toHaveAttribute("aria-busy", "false");
  // Only the latest turn's answer offers it.
  await expect(turns.first().getByRole("button", { name: "Regenerate response" })).toHaveCount(0);
  await expect(turns.last().getByRole("button", { name: "Regenerate response" })).toHaveCount(1);
  await last.hover();
  await shoot(page, info, "regenerate");
  const answered = await turns.last().getAttribute("data-turn");
  await log.getByRole("button", { name: "Regenerate response" }).click();
  await expect(turns.last()).not.toHaveAttribute("data-turn", answered!);
  await expect(log.getByRole("article", { name: "You" })).toHaveText([
    "hello",
    "/fail on purpose",
    "again",
  ]);
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Echo: again");
});

test("forks a thread from a response and merges the fork back into its source", async ({
  page,
}, info) => {
  const { message, log } = await thread(page, "plan the trip", "pick a city");
  const heading = page.getByRole("heading", { level: 2 });
  await expect(heading).toHaveText("plan the trip");

  await log.getByRole("article", { name: "Agent" }).first().hover();
  await log.getByRole("button", { name: "Fork from this response" }).first().click();

  // The fork opens with the turns up to that response and a marker after them.
  await expect(heading).toHaveText("plan the trip fork");
  await expect(log.getByRole("article", { name: "You" })).toHaveText(["plan the trip"]);
  await expect(
    log.getByRole("status").filter({ hasText: "Forked from conversation" }),
  ).toBeVisible();
  // The header's button (the details card beside the chat has one too, D1350).
  const mergeBack = page
    .locator("header")
    .getByRole("button", { name: "Merge back to plan the trip" });
  await expect(mergeBack).toBeDisabled();
  await shoot(page, info, "fork");

  await message.fill("try Lisbon");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Echo: try Lisbon");
  await expect(mergeBack).toBeEnabled();
  await mergeBack.click();

  // Back in the source; its next message carries the fork's result.
  await expect(heading).toHaveText("plan the trip");
  await message.fill("what did the fork find?");
  await message.press("Enter");
  await expect(log.getByRole("status").filter({ hasText: "Merged back from fork" })).toContainText(
    "plan the trip fork",
  );
  await expect(log.getByRole("article", { name: "You" }).last()).toHaveText(
    "what did the fork find?",
  );
  // The fake agent echoes what it got: the handoff came first.
  await expect(log.getByRole("article", { name: "Agent" }).last()).toContainText(
    "Merge-back context from forked conversation.",
  );
  await shoot(page, info, "merged-back");

  await log.getByRole("button", { name: "Open fork" }).click();
  await expect(heading).toHaveText("plan the trip fork");
  await log.getByRole("button", { name: "Open source conversation" }).click();
  await expect(heading).toHaveText("plan the trip");
});

test("finds threads by their messages from the sidebar and the palette", async ({ page }, info) => {
  const { message } = await thread(page, "an unrelated title", "the quokka lives on Rottnest");
  await page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await message.fill("quokka facts please");
  await message.press("Enter");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("quokka facts please");

  const search = page.getByRole("combobox", { name: "Search threads" });
  await search.fill("quokka");
  const results = page.getByRole("listbox", { name: "Thread search results" });
  // The title match first, then the thread found by a message, with its excerpt.
  await expect(results.getByRole("option")).toHaveCount(2);
  await expect(results.getByRole("option").first()).toHaveAccessibleName(/^quokka facts please/);
  const byContent = results.getByRole("option").nth(1);
  await expect(byContent).toHaveAccessibleName(/^an unrelated title/);
  await expect(byContent).toContainText("You: the quokka lives on Rottnest");
  await shoot(page, info, "sidebar-search");
  await search.fill("no such words anywhere");
  await expect(page.getByText("No threads found")).toBeVisible();
  await search.fill("");

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search commands" }).fill("rottnest");
  const option = palette.getByRole("option", { name: /an unrelated title/ });
  await expect(option).toContainText("You: the quokka lives on Rottnest");
  await shoot(page, info, "palette-search");
  await option.click();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("an unrelated title");
});

test("finds text in the thread with mod+f and steps through the matches (D801)", async ({
  page,
}, info) => {
  const { message } = await thread(page, "an apple a day", "another apple");
  await message.press("ControlOrMeta+f");
  const find = page.getByRole("searchbox", { name: "Find in thread" });
  await expect(find).toBeFocused();
  await find.fill("APPLE");
  // The user's two messages and the agent's two echoes.
  const count = page.getByRole("search", { name: "Find in thread" }).getByText(/^\d+\/\d+$/);
  await expect(count).toHaveText("1/4");
  await shoot(page, info, "thread-find");
  await find.press("Enter");
  await expect(count).toHaveText("2/4");
  await find.press("Shift+Enter");
  await find.press("Shift+Enter");
  await expect(count).toHaveText("4/4");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(count).toHaveText("1/4");

  await find.fill("pear");
  await expect(count).toHaveText("0/0");
  await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();

  await page.getByRole("button", { name: "Close find" }).click();
  await expect(find).toHaveCount(0);
  // Closing hands focus back to the composer; Escape closes the bar too.
  await expect(message).toBeFocused();
  await message.press("ControlOrMeta+f");
  await expect(find).toBeFocused();
  await find.press("Escape");
  await expect(find).toHaveCount(0);
  await expect(message).toBeFocused();
});

test("finds text in a finished turn's folded work and opens the fold (D1351)", async ({
  page,
}, info) => {
  const { message, log } = await thread(page, "/write grocery.txt eggs");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveText("Wrote grocery.txt");
  const fold = log.getByRole("button", { name: /^Worked for / });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await message.press("ControlOrMeta+f");
  const find = page.getByRole("searchbox", { name: "Find in thread" });
  await find.fill("grocery");
  const count = page.getByRole("search", { name: "Find in thread" }).getByText(/^\d+\/\d+$/);
  // The message, the folded tool row and the answer: the fold stays shut on the first.
  await expect(count).toHaveText("1/3");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  // The second is in the folded work, which opens to show it.
  await find.press("Enter");
  await expect(count).toHaveText("2/3");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(log.getByRole("button", { name: "Edited grocery.txt" })).toBeVisible();
  await shoot(page, info, "thread-find-fold");
  await find.press("Enter");
  await expect(count).toHaveText("3/3");
});

test("lists a thread's parent and forks in the thread details panel, and merges back from it (D802)", async ({
  page,
}, info) => {
  const { message, log } = await thread(page, "plan a picnic");
  await log.getByRole("article", { name: "Agent" }).first().hover();
  await log.getByRole("button", { name: "Fork from this response" }).first().click();
  const heading = page.getByRole("heading", { level: 2 });
  await expect(heading).toHaveText("plan a picnic fork");

  const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
  const panel = await showThreadDetails(page);
  const related = panel.getByRole("list", { name: "Related threads" });
  await expect(panel.getByRole("heading", { name: "Lineage" })).toBeVisible();
  await expect(related.getByRole("listitem")).toHaveText([/plan a picnic.*Idle/]);
  // D1350: at this width the card is beside the chat, not the popover, and the chat's lane
  // (its messages and composer) ends left of it.
  await expect(toggle).toHaveAttribute("data-details-effective", "inline");
  await expect(page.locator("[data-popup-open]")).toHaveCount(0);
  const card = (await panel.boundingBox())!;
  const lane = (await page.locator(".chat-content-lane").first().boundingBox())!;
  const composer = (await message.boundingBox())!;
  expect(lane.x + lane.width).toBeLessThanOrEqual(card.x);
  expect(composer.x + composer.width).toBeLessThanOrEqual(card.x);
  const merge = panel.getByRole("button", { name: "Merge back to plan a picnic" });
  await expect(merge).toBeDisabled();
  // An unavailable button still says why (aria-disabled, so it keeps its pointer and focus).
  await merge.hover();
  await expect(page.getByText("Complete a run in this fork before merging it back")).toBeVisible();
  await hideThreadDetails(page);

  await message.fill("bring lemonade");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText(
    "Echo: bring lemonade",
  );
  // The shortcut opens it too (T3's threadPanel.toggle).
  await page.keyboard.press("ControlOrMeta+Shift+B");
  await expect(related.getByRole("listitem")).toHaveText([/plan a picnic.*Done/]);
  await shoot(page, info, "lineage-fork");
  await panel.getByRole("button", { name: "Merge back to plan a picnic" }).click();
  await expect(heading).toHaveText("plan a picnic");

  // The parent lists its fork, which opens from the row.
  await showThreadDetails(page);
  await expect(related.getByRole("listitem")).toHaveText([/plan a picnic fork.*Done/]);
  await shoot(page, info, "lineage-parent");
  await related.getByRole("button", { name: /plan a picnic fork/ }).click();
  await expect(heading).toHaveText("plan a picnic fork");
  // The parent row opens the parent.
  await showThreadDetails(page);
  await related.getByRole("button", { name: /^plan a picnic / }).click();
  await expect(heading).toHaveText("plan a picnic");
  // Each thread keeps whether its details show (T3's per-thread visibility, D1350).
  await page.goBack();
  await expect(heading).toHaveText("plan a picnic fork");
  await expect(panel).toBeVisible();
  await hideThreadDetails(page);
  await page.goForward();
  await expect(heading).toHaveText("plan a picnic");
  await expect(panel).toBeVisible();
  await page.goBack();
  await expect(heading).toHaveText("plan a picnic fork");
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
