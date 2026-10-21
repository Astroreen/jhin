// The queue on the node and steering (docs/plans/t3-parity.md, D201–D210),
// against the fake agent: "/hold" holds its turn until it is stopped or steered.
import { expect, test, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

/** Starts a thread whose turn holds, and returns its composer's message box. */
async function holdingThread(page: Page) {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/hold on");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Holding");
  return message;
}

const queued = (page: Page) => page.getByRole("region", { name: /queued message/ });
const rows = (page: Page) => queued(page).getByRole("listitem");

test("queues follow-ups on the node, keeps them past a reload and edits, reorders and removes them", async ({
  page,
}, info) => {
  const message = await holdingThread(page);
  for (const text of ["first follow-up", "second follow-up", "third follow-up"]) {
    await message.fill(text);
    await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();
    await message.press("Enter");
  }
  await expect(queued(page)).toHaveAccessibleName("3 queued messages");

  // The queue lives on the node: a reload still shows it.
  await page.reload();
  await expect(rows(page)).toHaveText([/first follow-up/, /second follow-up/, /third follow-up/]);

  // Reorder with the keyboard on the grip.
  await rows(page)
    .nth(2)
    .getByRole("button", { name: /Reorder queued message/ })
    .press("ArrowUp");
  await expect(rows(page)).toHaveText([/first follow-up/, /third follow-up/, /second follow-up/]);

  // Edit in the composer, then save.
  await rows(page).nth(0).getByRole("button", { name: "Edit queued message" }).click();
  await expect(message).toHaveText("first follow-up");
  await message.fill("first, edited");
  await page.getByRole("button", { name: "Save queued message" }).click();
  await expect(rows(page).nth(0)).toContainText("first, edited");
  await expect(message).toHaveText("");

  await rows(page).nth(2).getByRole("button", { name: "Remove queued message" }).click();
  await expect(queued(page)).toHaveAccessibleName("2 queued messages");

  const shot = info.outputPath("queue.png");
  await page.screenshot({ path: shot });
  await info.attach("queue", { path: shot, contentType: "image/png" });

  // Steering the holding turn ends it; the queue then goes out turn by turn.
  await rows(page).nth(1).getByRole("button", { name: "Steer" }).click();
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" }).nth(1)).toHaveText("third follow-up");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText(
    "Echo: first, edited",
  );
  await expect(queued(page)).toHaveCount(0);
});

test("holds the queue after a stop until it is resumed, and steers with the other key", async ({
  page,
}, info) => {
  const message = await holdingThread(page);
  await message.fill("waits for the stop");
  await message.press("Enter");
  await page.getByRole("button", { name: "Stop generation" }).click();

  await expect(queued(page).getByRole("alert")).toHaveText("The turn was stopped: the queue waits");
  const shot = info.outputPath("held.png");
  await page.screenshot({ path: shot });
  await info.attach("held queue", { path: shot, contentType: "image/png" });
  await queued(page).getByRole("button", { name: "Resume" }).click();
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText(
    "Echo: waits for the stop",
  );

  // ⌘/Ctrl+Enter does the opposite of "Queue": the message steers the running turn.
  await message.fill("/hold again");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Holding");
  await message.fill("steered in");
  await message.press("ControlOrMeta+Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Echo: steered in");
  await expect(queued(page)).toHaveCount(0);

  // The queue's shortcuts are commands (D210): Alt+↑ edits the last queued
  // message, ⌘/Ctrl+Shift+Enter steers the first one into the running turn.
  await message.fill("/hold once more");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Holding");
  await message.fill("shortcut follow-up");
  await message.press("Enter");
  await expect(rows(page)).toHaveText([/shortcut follow-up/]);
  // With text before the caret, Alt+↑ is the browser's: nothing is loaded.
  await message.fill("half typed");
  await message.press("End");
  await message.press("Alt+ArrowUp");
  await expect(message).toHaveText("half typed");
  await message.fill("");
  await message.press("Alt+ArrowUp");
  await expect(message).toHaveText("shortcut follow-up");
  await rows(page).getByRole("button", { name: "Cancel editing queued message" }).click();
  await message.press("ControlOrMeta+Shift+Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText(
    "Echo: shortcut follow-up",
  );
  await expect(queued(page)).toHaveCount(0);
});

test("resumes a stopped turn with T3's message, then lets the held queue go on (D800)", async ({
  page,
}, info) => {
  const message = await holdingThread(page);
  await message.fill("after the resume");
  await message.press("Enter");
  await page.getByRole("button", { name: "Stop generation" }).click();
  await expect(queued(page).getByRole("alert")).toHaveText("The turn was stopped: the queue waits");

  // Typed text keeps the send button; an empty composer offers the resume.
  const resume = page.getByRole("button", { name: "Resume thread" });
  await message.fill("typed");
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(resume).toHaveCount(0);
  await message.fill("");
  await expect(resume).toBeVisible();
  const shot = info.outputPath("resume-thread.png");
  await page.screenshot({ path: shot });
  await info.attach("resume thread", { path: shot, contentType: "image/png" });

  await resume.click();
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" })).toHaveText([
    /\/hold on/,
    /Continue where you left off\./,
    /after the resume/,
  ]);
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText(
    "Echo: after the resume",
  );
  await expect(queued(page)).toHaveCount(0);
  await expect(resume).toHaveCount(0);
});

test("sends typed text the other way with ⌘/Ctrl+Shift+Enter when ⌘/Ctrl+Enter sends, and steers nothing else", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "jhin.settings",
      JSON.stringify({ "jhin.chat": { sendShortcut: "mod-enter" } }),
    ),
  );
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/hold first");
  await message.press("ControlOrMeta+Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Holding");
  await message.fill("/hold queued");
  await message.press("ControlOrMeta+Enter");
  await expect(rows(page)).toHaveText([/\/hold queued/]);

  // Typed text owns the chord: it steers the running turn, and the queued
  // message is not steered with it; it starts a turn of its own afterwards.
  await message.fill("typed");
  await message.press("ControlOrMeta+Shift+Enter");
  await expect(log.getByText("Echo: typed")).toBeVisible();
  await expect(queued(page)).toHaveCount(0);
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Holding");
  await expect(log.getByText("Echo: /hold queued")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop generation" }).click();
});
