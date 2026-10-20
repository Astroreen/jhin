import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

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
  await expect(message).toHaveValue("second question");

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
  await expect(message).toHaveValue("a draft");
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
