import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { expectOpenConnections, newThreadOn, threadRow } from "./support/ui.ts";

const running: RunningNode[] = [];
test.afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

async function start(options: Parameters<typeof startNode>[0]): Promise<RunningNode> {
  const node = await startNode(options);
  running.push(node);
  return node;
}

/** A folder named `name` in the node's home, added as a project there. */
async function addProject(node: RunningNode, name: string): Promise<void> {
  const path = Path.join(node.home, name);
  Fs.mkdirSync(path, { recursive: true });
  await node.client().call("projects.create", { path });
}

/** A thread with one finished turn, made through the node's API. */
async function addThread(node: RunningNode, text: string): Promise<void> {
  const thread = await node.client().call<{ id: string }>("threads.create", {});
  await node.client().call("threads.send", { threadId: thread.id, text });
}

async function send(page: Page, text: string): Promise<void> {
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(`Echo: ${text}`);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not rendered");
  return found;
}

test("D70–D74: thread cards in one list, named by node only while several are shown", async ({
  page,
}, info) => {
  const x = await start({ mode: "ui" });
  const y = await start({ mode: "serve" });
  const xHost = new URL(x.ui).host;
  const yHost = new URL(y.rpc).host;
  await addProject(x, "web");
  await addProject(y, "web");

  await page.goto(`${x.ui}#token=${x.token}`);
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await send(page, "on x");
  // One node: a card with its project and title, and nothing about where it lives.
  const onX = threadRow(page, "on x");
  await expect(onX).toHaveAccessibleName("on x, No project");
  await expect(onX).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-host-indicator]")).toHaveCount(0);
  // Nothing settled yet: the shelf is there, collapsed.
  await expect(page.getByRole("button", { name: "Settled (0)" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const oneNode = info.outputPath("sidebar-one-node.png");
  await page.screenshot({ path: oneNode });
  await info.attach("sidebar-one-node", { path: oneNode, contentType: "image/png" });

  // D73: settings leads the footer, as in T3.
  const settings = await box(page.getByRole("button", { name: "Settings", exact: true }));
  const palette = await box(page.getByRole("button", { name: "Command palette" }));
  const search = await box(page.getByRole("combobox", { name: "Search threads" }));
  expect(settings.x).toBeLessThan(palette.x);
  expect(settings.x).toBeLessThan(search.x + search.width / 2);

  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Node URL" }).fill(y.rpc);
  await page.getByRole("textbox", { name: "Token" }).fill(y.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expectOpenConnections(page, 2);
  await newThreadOn(page, yHost);
  await send(page, "on y");

  // D71: two nodes, no section per node: every card names its node, also in its name.
  const onY = threadRow(page, "on y");
  await expect(onY).toHaveAttribute("aria-current", "page");
  await expect(onY).toHaveAccessibleName(`on y, No project on ${yHost}`);
  await expect(onX.getByLabel(`On ${xHost}`, { exact: true })).toBeAttached();
  await expect(onY.getByLabel(`On ${yHost}`, { exact: true })).toBeAttached();
  await expect(page.getByRole("region", { name: /^Node / })).toHaveCount(0);
  const shot = info.outputPath("sidebar-two-nodes.png");
  await page.screenshot({ path: shot });
  await info.attach("sidebar-two-nodes", { path: shot, contentType: "image/png" });

  // D71: the project filter keeps the two projects called "web" apart by their node.
  await page.getByRole("combobox", { name: "Filter threads by project" }).click();
  await expect(page.getByRole("option", { name: new RegExp(`^web.*${xHost}`) })).toHaveCount(1);
  await page.getByRole("option", { name: new RegExp(`^web.*${yHost}`) }).click();
  await expect(page.getByText("No threads in web yet")).toBeVisible();
  await expect(onX).toHaveCount(0);
  await page.getByRole("combobox", { name: `Filter threads by project: web on ${yHost}` }).click();
  await page.getByRole("option", { name: "All projects" }).click();
  await expect(onX).toBeVisible();

  // Search lists matching threads; Enter opens the highlighted one.
  const field = page.getByRole("combobox", { name: "Search threads" });
  await field.fill("on x");
  await expect(
    page.getByRole("listbox", { name: "Thread search results" }).getByRole("option"),
  ).toHaveCount(1);
  await field.press("Enter");
  await expect(onX).toHaveAttribute("aria-current", "page");

  // D72: adding a project asks on which node.
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const adding = page.getByRole("dialog", { name: "Add project" });
  await adding.getByRole("combobox", { name: "Node" }).click();
  await page.getByRole("option", { name: xHost, exact: true }).click();
  await expect(adding.getByText(`A folder on ${xHost}.`, { exact: false })).toBeVisible();
  await adding.getByRole("button", { name: "Cancel" }).click();

  // D72: the node's actions live in its menu in settings → Nodes (the `node.actions` slot).
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  await page.getByRole("button", { name: `More actions for ${yHost}` }).click();
  for (const item of [
    "New thread without a project",
    "Add project",
    "Rename on this device",
    "Copy address",
    "Disconnect",
  ]) {
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await page.getByRole("menuitem", { name: "Rename on this device" }).click();

  // D74: the dialog's footer is part of its panel, not a box below it.
  const dialog = page.getByRole("dialog", { name: "Rename node" });
  const panel = await box(dialog);
  const rename = await box(dialog.getByRole("button", { name: "Rename" }));
  const field2 = await box(dialog.getByRole("textbox", { name: "Node name" }));
  expect(rename.y + rename.height).toBeLessThanOrEqual(panel.y + panel.height);
  expect(rename.y).toBeGreaterThan(field2.y + field2.height);
  const dialogShot = info.outputPath("rename-node-dialog.png");
  await page.screenshot({ path: dialogShot });
  await info.attach("rename-node-dialog", { path: dialogShot, contentType: "image/png" });

  await dialog.getByRole("textbox", { name: "Node name" }).fill("studio");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(onY.getByLabel("On studio", { exact: true })).toBeAttached();
});

test("D70, D446: threads the node settles go onto the Settled shelf, live", async ({
  page,
}, info) => {
  const x = await start({ mode: "ui" });
  await addThread(x, "first quiet thread");
  await addThread(x, "second quiet thread");
  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(page.getByTestId("sidebar-row-card")).toHaveCount(2);

  // The node settles them by its own rule, here on their pull requests closing (D447); the
  // client settles nothing by itself (its clock four days on would change nothing).
  const threads = await x.client().call<{ id: string }[]>("threads.list", {});
  const closedAt = new Date(Date.now() + 60_000).toISOString();
  for (const thread of threads) {
    await x.client().call("threads.auto-settle", {
      threadId: thread.id,
      reason: "pull-request-closed",
      closedAt,
    });
  }

  const shelf = page.getByRole("button", { name: "Settled (2)" });
  await expect(shelf).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("sidebar-row-card")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-row-slim")).toHaveCount(0);

  await shelf.click();
  const expanded = page.getByRole("button", { name: "Settled", exact: true });
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
  // Most recently settled first, as slim rows.
  await expect(page.getByTestId("sidebar-row-slim")).toHaveText([
    /second quiet thread/,
    /first quiet thread/,
  ]);
  await threadRow(page, "first quiet thread").click();
  await expect(threadRow(page, "first quiet thread")).toHaveAttribute("aria-current", "page");
  const shot = info.outputPath("sidebar-settled.png");
  await page.screenshot({ path: shot });
  await info.attach("sidebar-settled", { path: shot, contentType: "image/png" });

  // Collapsed again, the open thread stays in sight.
  await expanded.click();
  await expect(page.getByTestId("sidebar-row-slim")).toHaveCount(1);
  await expect(threadRow(page, "first quiet thread")).toBeVisible();
});

/** The cards' titles, top to bottom. */
const cardTitles = (page: Page) =>
  page.getByTestId("sidebar-row-card").locator("[data-thread-title]");

/** Drags a row onto another one with small pointer steps, as a hand does (dnd-kit waits for 6 px). */
async function drag(page: Page, from: Locator, to: Locator, offset = 0): Promise<void> {
  const source = await box(from);
  const end = await box(to);
  const x = source.x + source.width / 2;
  await page.mouse.move(x, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, source.y + source.height / 2 + 10, { steps: 4 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2 + offset, { steps: 20 });
  await page.mouse.up();
}

test("D75–D77: settle, pin and snooze from the sidebar, kept on the node for every device", async ({
  page,
  browser,
}, info) => {
  const x = await start({ mode: "ui" });
  await addThread(x, "alpha");
  await addThread(x, "beta");
  await addThread(x, "gamma");
  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(cardTitles(page)).toHaveText(["gamma", "beta", "alpha"]);

  // Settle from the card: it goes to the shelf and the next card opens (T3's settle-and-advance).
  await threadRow(page, "beta").click();
  await threadRow(page, "beta").hover();
  await threadRow(page, "beta").getByRole("button", { name: "Settle thread" }).click();
  await expect(page.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await expect(cardTitles(page)).toHaveText(["gamma", "alpha"]);
  await expect(threadRow(page, "alpha")).toHaveAttribute("aria-current", "page");

  // Another device sees it: settlement lives on the node.
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(`${x.ui}#token=${x.token}`);
  await expect(second.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await expect(cardTitles(second)).toHaveText(["gamma", "alpha"]);

  // Pin from the context menu (the thread.actions slot): on top, with its pin.
  await threadRow(page, "alpha").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin thread" }).click();
  await expect(cardTitles(page)).toHaveText(["alpha", "gamma"]);
  await expect(
    threadRow(page, "alpha").getByRole("button", { name: "Unpin thread" }),
  ).toBeVisible();
  await expect(cardTitles(second)).toHaveText(["alpha", "gamma"]);
  const pinned = info.outputPath("sidebar-pinned.png");
  await page.screenshot({ path: pinned });
  await info.attach("sidebar-pinned", { path: pinned, contentType: "image/png" });

  // Snooze with a preset: the Snoozed shelf counts it, and its row says when it wakes.
  await threadRow(page, "gamma").hover();
  await threadRow(page, "gamma").getByRole("button", { name: "Snooze thread" }).click();
  await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();
  const snoozedShelf = page.getByRole("button", { name: "Snoozed (1)" });
  await expect(snoozedShelf).toBeVisible();
  await snoozedShelf.click();
  await expect(threadRow(page, "gamma")).toHaveAttribute("data-section", "snoozed");
  // Drawn as of the change, rounded up as T3 does: just under an hour is "60m".
  await expect(threadRow(page, "gamma")).toContainText(/(60m|1h)$/);
  await page.getByRole("button", { name: "Settled (1)" }).click();
  const shelves = info.outputPath("sidebar-shelves.png");
  await page.screenshot({ path: shelves });
  await info.attach("sidebar-shelves", { path: shelves, contentType: "image/png" });

  // The shortcut settles the open pinned thread, which unpins it.
  await threadRow(page, "alpha").click();
  await page.keyboard.press("Control+Shift+S");
  await expect(threadRow(page, "alpha")).toHaveAttribute("data-section", "settled");
  await expect(page.getByRole("button", { name: "Settled", exact: true })).toBeVisible();

  // Un-settle from the shelf: back on top of the active threads.
  await threadRow(page, "beta").hover();
  await threadRow(page, "beta").getByRole("button", { name: "Un-settle thread" }).click();
  await expect(cardTitles(page)).toHaveText(["beta"]);

  // A new turn brings a settled thread back to the top; it wakes a snoozed one, which
  // takes its place by creation (the threads back from the shelf are newer there).
  const threads = await x.client().call<{ id: string; title: string }[]>("threads.list", {});
  const id = (title: string) => threads.find((thread) => thread.title === title)!.id;
  await x.client().call("threads.send", { threadId: id("alpha"), text: "again" });
  await expect(cardTitles(page)).toHaveText(["alpha", "beta"]);
  await x.client().call("threads.send", { threadId: id("gamma"), text: "again" });
  await expect(cardTitles(page)).toHaveText(["alpha", "beta", "gamma"]);
  await expect(page.getByRole("button", { name: /^Snoozed/ })).toHaveCount(0);
  await expect(cardTitles(second)).toHaveText(["alpha", "beta", "gamma"]);
  await other.close();
});

test("D77: a custom snooze hides a thread until its time, and its card says it woke", async ({
  page,
}, info) => {
  const x = await start({ mode: "ui" });
  await addThread(x, "later please");
  await addThread(x, "keep going");
  await page.clock.install();
  await page.goto(`${x.ui}#token=${x.token}`);

  await threadRow(page, "later please").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Snooze" }).hover();
  await page.getByRole("menuitem", { name: "Custom…" }).click();
  const dialog = page.getByRole("dialog", { name: "Custom snooze" });
  await dialog.getByRole("button", { name: "Duration" }).click();
  await dialog.getByRole("spinbutton", { name: "Snooze for" }).fill("1");
  const custom = info.outputPath("custom-snooze.png");
  await page.screenshot({ path: custom });
  await info.attach("custom-snooze", { path: custom, contentType: "image/png" });
  await dialog.getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByRole("button", { name: "Snoozed (1)" })).toBeVisible();
  await expect(cardTitles(page)).toHaveText(["keep going"]);
  await threadRow(page, "keep going").hover();
  await threadRow(page, "keep going").getByRole("button", { name: "Snooze thread" }).click();
  await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();
  await expect(page.getByRole("button", { name: "Snoozed (2)" })).toBeVisible();

  // An hour on, the snooze's own tick brings them back, saying they woke.
  await page.clock.fastForward("01:00:30");
  await expect(cardTitles(page)).toHaveText(["keep going", "later please"]);
  const woke = threadRow(page, "later please");
  await expect(woke).toHaveAccessibleName(/^later please, Woke, /);
  await expect(threadRow(page, "keep going")).toHaveAccessibleName(/^keep going, Woke, /);
  const shot = info.outputPath("sidebar-woke.png");
  await page.screenshot({ path: shot });
  await info.attach("sidebar-woke", { path: shot, contentType: "image/png" });
  // Dismissed from the card, or seen by opening the thread.
  await woke.getByRole("button", { name: "Dismiss Woke notification" }).click();
  await expect(woke).toHaveAccessibleName("later please, No project");
  await threadRow(page, "keep going").click();
  await expect(threadRow(page, "keep going")).toHaveAccessibleName("keep going, No project");
});

test("D78: dragging reorders the pinned and active threads and settles onto the shelf", async ({
  page,
}, info) => {
  const x = await start({ mode: "ui" });
  for (const title of ["one", "two", "three", "pin a", "pin b"]) await addThread(x, title);
  const threads = await x.client().call<{ id: string; title: string }[]>("threads.list", {});
  const id = (title: string) => threads.find((thread) => thread.title === title)!.id;
  await x.client().call("threads.pin", { threadId: id("pin a"), orderKey: "c" });
  await x.client().call("threads.pin", { threadId: id("pin b"), orderKey: "n" });
  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(cardTitles(page)).toHaveText(["pin a", "pin b", "three", "two", "one"]);

  // Within the pinned threads. Rows hold still while a drop is written (T3 disables them too),
  // so each drag waits for the dropped row to stop being busy: the nodes have it.
  await drag(page, threadRow(page, "pin b"), threadRow(page, "pin a"), -20);
  await expect(cardTitles(page)).toHaveText(["pin b", "pin a", "three", "two", "one"]);
  await expect(threadRow(page, "pin b")).not.toHaveAttribute("aria-busy", "true");
  // Within the active ones: the order is kept on the node.
  await drag(page, threadRow(page, "one"), threadRow(page, "three"), -20);
  await expect(cardTitles(page)).toHaveText(["pin b", "pin a", "one", "three", "two"]);
  await expect(threadRow(page, "one")).not.toHaveAttribute("aria-busy", "true");
  // Onto the Settled shelf.
  await drag(page, threadRow(page, "two"), page.getByRole("button", { name: "Settled (0)" }));
  await expect(page.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await expect(cardTitles(page)).toHaveText(["pin b", "pin a", "one", "three"]);

  await page.reload();
  await expect(cardTitles(page)).toHaveText(["pin b", "pin a", "one", "three"]);
  const shot = info.outputPath("sidebar-dragged.png");
  await page.screenshot({ path: shot });
  await info.attach("sidebar-dragged", { path: shot, contentType: "image/png" });
});

test("D445: a thread's Auto-settle behavior, kept on the node", async ({ page }, info) => {
  const x = await start({ mode: "ui" });
  await addThread(x, "keep me around");
  const [thread] = await x.client().call<{ id: string }[]>("threads.list", {});
  await page.goto(`${x.ui}#token=${x.token}`);

  await threadRow(page, "keep me around").click({ button: "right" });
  // Opened with the keyboard: a hover-opened submenu closes when the pointer leaves its trigger.
  await page.getByRole("menuitem", { name: "Auto-settle behavior" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menuitemradio", { name: "Enabled" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const shot = info.outputPath("auto-settle-menu.png");
  await page.screenshot({ path: shot });
  await info.attach("auto-settle-menu", { path: shot, contentType: "image/png" });
  await page.getByRole("menuitemradio", { name: "Disabled" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Disabled" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Kept on the node: its rule leaves the thread alone, even for a closed pull request.
  const { thread: record } = await x
    .client()
    .call<{ thread: { autoSettleDisabledAt?: string } }>("threads.get", { threadId: thread!.id });
  expect(record.autoSettleDisabledAt).toEqual(expect.any(String));
  expect(
    await x.client().call("threads.auto-settle", {
      threadId: thread!.id,
      reason: "pull-request-closed",
      closedAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  ).toEqual({ settled: false });
  await expect(page.getByRole("button", { name: "Settled (0)" })).toBeVisible();
});

test("D450: undo an unpin, a settle and an archive from the sidebar's notice", async ({
  page,
}, info) => {
  const x = await start({ mode: "ui" });
  await addThread(x, "first");
  await addThread(x, "second");
  const threads = await x.client().call<{ id: string; title: string }[]>("threads.list", {});
  const second = threads.find((thread) => thread.title === "second")!;
  await x.client().call("threads.pin", { threadId: second.id, orderKey: "n" });
  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(cardTitles(page)).toHaveText(["second", "first"]);

  // Unpin from the card: the footer offers to undo it, with the shortcut.
  await threadRow(page, "second").hover();
  await threadRow(page, "second").getByRole("button", { name: "Unpin thread" }).click();
  const notice = page.getByRole("status").filter({ hasText: /to undo$|Undo$/ });
  await expect(notice).toHaveText("Unpinned 1 thread, Ctrl+Z to undo");
  const shot = info.outputPath("undo-notice.png");
  await page.screenshot({ path: shot });
  await info.attach("undo-notice", { path: shot, contentType: "image/png" });
  await page.keyboard.press("Control+z");
  await expect(notice).toHaveCount(0);
  await expect(
    threadRow(page, "second").getByRole("button", { name: "Unpin thread" }),
  ).toBeAttached();
  const { thread: repinned } = await x
    .client()
    .call<{ thread: { pinOrderKey?: string } }>("threads.get", { threadId: second.id });
  expect(repinned.pinOrderKey).toBe("n");

  // Settling a pinned thread and undoing it brings it back pinned.
  await threadRow(page, "second").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle thread" }).click();
  await expect(page.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await expect(notice).toHaveText("Settled 1 thread, Ctrl+Z to undo");
  await notice.getByRole("button", { name: "Ctrl+Z to undo" }).click();
  await expect(page.getByRole("button", { name: "Settled (0)" })).toBeVisible();
  await expect(cardTitles(page)).toHaveText(["second", "first"]);

  // Archiving says so in the same place.
  await threadRow(page, "first").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive thread" }).click();
  await expect(notice).toHaveText("Archived 1 thread, Ctrl+Z to undo");
  await notice.getByRole("button", { name: "Ctrl+Z to undo" }).click();
  await expect(cardTitles(page)).toHaveText(["second", "first"]);
});

test("D451: discard a new thread's draft from its card, and undo it", async ({ page }, info) => {
  const x = await start({ mode: "ui" });
  await page.goto(`${x.ui}#token=${x.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("half a thought");
  const draft = page.getByTestId("sidebar-draft-row");
  await expect(draft).toBeVisible();

  await draft.hover();
  const shot = info.outputPath("discard-draft.png");
  await page.screenshot({ path: shot });
  await info.attach("discard-draft", { path: shot, contentType: "image/png" });
  await draft.getByRole("button", { name: "Discard draft" }).click();
  await expect(draft).toHaveCount(0);
  await expect(message).toHaveCount(0);
  const notice = page.getByRole("status").filter({ hasText: "Discarded" });
  await expect(notice).toHaveText("Discarded 1 draft, Ctrl+Z to undo");

  // Undo: the draft is back, with its text.
  await notice.getByRole("button", { name: "Ctrl+Z to undo" }).click();
  await expect(draft).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveText("half a thought");

  // A draft written again meanwhile is not overwritten by an undo (T3's words).
  await draft.hover();
  await draft.getByRole("button", { name: "Discard draft" }).click();
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Start a thread" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("a new thought");
  await notice.getByRole("button", { name: "Ctrl+Z to undo" }).click();
  await expect(page.getByText("Failed to restore draft")).toBeVisible();
  await expect(page.getByText("The draft has new content.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveText("a new thought");
});

test("D452: the Working section folds threads at work until they need you", async ({
  page,
}, info) => {
  const x = await start({ mode: "ui" });
  await addThread(x, "quiet one");
  await addThread(x, "/hold busy one");
  await page.goto(`${x.ui}#token=${x.token}`);
  // Off by default: the running thread is a card among the others.
  await expect(cardTitles(page)).toHaveText(["/hold busy one", "quiet one"]);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Working section" }).click();
  await page.getByRole("button", { name: "Back" }).click();

  const header = page.getByRole("button", { name: "Working (1)" });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(cardTitles(page)).toHaveText(["quiet one"]);
  await header.click();
  await expect(page.getByRole("button", { name: "Working", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(cardTitles(page)).toHaveText(["quiet one", "/hold busy one"]);
  const shot = info.outputPath("working-section.png");
  await page.screenshot({ path: shot });
  await info.attach("working-section", { path: shot, contentType: "image/png" });

  // Its turn ends: back on top of the inbox, the section gone.
  await threadRow(page, "/hold busy one").click();
  await page.getByRole("button", { name: "Stop generation" }).click();
  await expect(page.getByRole("button", { name: /^Working/ })).toHaveCount(0);
  await expect(cardTitles(page)).toHaveText(["/hold busy one", "quiet one"]);
});

test("D453: holding the jump modifier shows the rows' numbers", async ({ page }, info) => {
  const x = await start({ mode: "ui" });
  for (const title of ["first", "second", "third"]) await addThread(x, title);
  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(cardTitles(page)).toHaveText(["third", "second", "first"]);
  const hints = page.locator("[data-jump-hint]");
  await expect(hints).toHaveCount(0);

  // Held (after T3's 200 ms), the rows show the shortcuts that open them.
  await page.keyboard.down("Control");
  await expect(hints).toHaveText(["Ctrl+1", "Ctrl+2", "Ctrl+3"]);
  const shot = info.outputPath("jump-hints.png");
  await page.screenshot({ path: shot });
  await info.attach("jump-hints", { path: shot, contentType: "image/png" });
  await page.keyboard.press("2");
  await expect(threadRow(page, "second")).toHaveAttribute("aria-current", "page");
  await page.keyboard.up("Control");
  await expect(hints).toHaveCount(0);
});

test("D454: select several threads and act on them at once", async ({ page }, info) => {
  const x = await start({ mode: "ui" });
  for (const title of ["one", "two", "three", "four"]) await addThread(x, title);
  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(cardTitles(page)).toHaveText(["four", "three", "two", "one"]);

  // Ctrl+click picks a row, Shift+click adds the rows up to another; Escape clears.
  await threadRow(page, "four").click({ modifiers: ["Control"] });
  await expect(threadRow(page, "four")).toHaveAttribute("data-selected", "");
  await page.keyboard.press("Escape");
  await expect(threadRow(page, "four")).not.toHaveAttribute("data-selected");
  await threadRow(page, "four").click({ modifiers: ["Control"] });
  await threadRow(page, "two").click({ modifiers: ["Shift"] });
  for (const title of ["four", "three", "two"])
    await expect(threadRow(page, title)).toHaveAttribute("data-selected", "");
  await expect(threadRow(page, "one")).not.toHaveAttribute("data-selected");
  await expect(page.locator("main")).toContainText("No active thread");

  await threadRow(page, "three").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Settle (3)" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Mark unread (3)" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete (3)" })).toBeVisible();
  const shot = info.outputPath("multi-select.png");
  await page.screenshot({ path: shot });
  await info.attach("multi-select", { path: shot, contentType: "image/png" });
  await page.getByRole("menuitem", { name: "Settle (3)" }).click();
  await expect(page.getByRole("button", { name: "Settled (3)" })).toBeVisible();
  await expect(cardTitles(page)).toHaveText(["one"]);
  await expect(page.getByRole("status").filter({ hasText: "Settled" })).toHaveText(
    "Settled 3 threads, Ctrl+Z to undo",
  );

  // A plain click opens one thread and ends the selection: its menu is the thread's own.
  await threadRow(page, "one").click();
  await threadRow(page, "one").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Settle thread" })).toBeVisible();
});

test("D454: a selection's Delete asks once, and Mark unread marks them all", async ({ page }) => {
  const x = await start({ mode: "ui" });
  for (const title of ["keep", "drop a", "drop b"]) await addThread(x, title);
  await page.goto(`${x.ui}#token=${x.token}`);
  await expect(cardTitles(page)).toHaveText(["drop b", "drop a", "keep"]);

  // Seen first: no "Done" on them; marked unread together, both say "Done" again.
  for (const title of ["drop b", "drop a"]) await threadRow(page, title).click();
  await threadRow(page, "keep").click();
  for (const title of ["drop b", "drop a"])
    await expect(threadRow(page, title).getByText("Done")).toHaveCount(0);
  await threadRow(page, "drop b").click({ modifiers: ["Control"] });
  await threadRow(page, "drop a").click({ modifiers: ["Control"] });
  await threadRow(page, "drop a").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark unread (2)" }).click();
  for (const title of ["drop b", "drop a"])
    await expect(threadRow(page, title).getByText("Done")).toBeVisible();

  await threadRow(page, "drop b").click({ modifiers: ["Control"] });
  await threadRow(page, "drop a").click({ modifiers: ["Control"] });
  await threadRow(page, "drop a").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete (2)" }).click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(dialog).toContainText("Delete 2 threads?");
  await expect(dialog).toContainText(
    "This permanently clears conversation history for these threads.",
  );
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(cardTitles(page)).toHaveText(["keep"]);
  expect(
    (await x.client().call<{ title: string }[]>("threads.list", {})).map((t) => t.title),
  ).toEqual(["keep"]);
});
