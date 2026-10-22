import { expect, test } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { threadRow } from "./support/ui.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

test("connects with the token from the URL, sends a message and streams the reply", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);

  // The token never stays in the address bar.
  await expect(page).not.toHaveURL(/token=/);
  // The sidebar's actions need an open node.
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("hello there");
  await message.press("Enter");

  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" })).toHaveText("hello there");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveText("Echo: hello there");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveAttribute("aria-busy", "false");
  // The new thread is listed and selected in the sidebar, titled after its first message.
  await expect(threadRow(page, "hello there")).toHaveAttribute("aria-current", "page");
  await expect(threadRow(page, "hello there")).toHaveAccessibleName("hello there, No project");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("hello there");

  const shot = info.outputPath("chat.png");
  await page.screenshot({ path: shot });
  await info.attach("chat", { path: shot, contentType: "image/png" });
});

test("stops a running turn", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/hold please");
  await message.press("Enter");

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Holding");
  await page.getByRole("button", { name: "Stop generation" }).click();

  await expect(page.getByText("Run interrupted")).toBeVisible();
  await expect(page.getByText(/^You stopped after /)).toBeVisible();
  // T3's "Resume thread" stands in for the send button of an empty composer (D800).
  await expect(page.getByRole("button", { name: "Resume thread" })).toBeVisible();
  await message.fill("next");
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
});

test("asks for approval in the composer and runs the tool once approved", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/approve rm -rf build");
  await message.press("Enter");

  await expect(page.getByRole("group", { name: "Command approval" })).toContainText("rm -rf build");
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText(
    "Approved and ran rm -rf build",
  );
  // The settled turn folds its work behind a summary.
  await expect(page.getByRole("button", { name: /^Worked for / })).toBeVisible();
});

test("answers the agent's question from the composer", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/ask");
  await message.press("Enter");

  await expect(page.getByText("Which color should I use?")).toBeVisible();
  await page.getByRole("button", { name: /^Blue/ }).click();
  await page.getByRole("button", { name: "Submit answer" }).click();

  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("You chose Blue");
});

test("edits a prefilled answer as literal text and sends it back as typed", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/edit");
  await message.press("Enter");

  // The answer is prefilled (D1001), its lines and leading spaces kept.
  await expect(page.getByText("Edit the message before I send it")).toBeVisible();
  await expect(message.locator("p")).toHaveText(["Dear team,", "  the build is green."]);
  await message.press("ControlOrMeta+End");
  await message.pressSequentially(" **Ship** it.");
  // Literal text: `**` stays as typed, never bold.
  await expect(message.locator("strong")).toHaveCount(0);
  await expect(message.locator("p").last()).toHaveText("the build is green. **Ship** it.");
  const shot = info.outputPath("prefilled-answer.png");
  await page.screenshot({ path: shot });
  await info.attach("prefilled-answer", { path: shot, contentType: "image/png" });
  await page.getByRole("button", { name: "Submit answer" }).click();

  // The answer went back exactly as edited: the two leading spaces (a pattern, not a string,
  // which would fold them into one) and the `**` the agent's reply then shows as bold.
  const reply = page.getByRole("article", { name: "Agent" });
  await expect(reply).toHaveText(/^You wrote "Dear team,\\n {2}the build is green\. Ship it\."$/);
  await expect(reply.locator("strong")).toHaveText("Ship");
  await expect(message).toHaveText("");
});

test("archives a thread, which then takes no messages until it is unarchived", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("to be archived");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: to be archived");

  // Archived from the row's context menu (the thread.actions slot).
  await threadRow(page, "to be archived").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive thread" }).click();
  await expect(threadRow(page, "to be archived")).toHaveCount(0);

  // Back on the archived thread: no composer, a way back instead.
  await page.goBack();
  await expect(page.getByRole("main").getByRole("status")).toHaveText(/This thread is archived/);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(threadRow(page, "to be archived")).toBeVisible();
});

test("finds a thread from the command palette", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("palette target");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toHaveText("Echo: palette target");

  await page.getByRole("button", { name: "New thread", exact: true }).first().click();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search commands" }).fill("palette target");
  await palette.getByRole("option", { name: /palette target/ }).click();

  await expect(palette).toBeHidden();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("palette target");
});

test("shows the node's live state in the inspector", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await expect(page.getByRole("button", { name: "New thread", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Inspector" }).click();

  const panel = page.getByRole("region", { name: "Inspector" });
  await expect(panel).toContainText('"id": "jhin.threads"');
  await expect(panel).toContainText('"status": "active"');
  await panel.getByRole("button", { name: "Close inspector" }).click();
  await expect(panel).toBeHidden();
});

test("serves the client strictly: 404 for missing files, 400 for bad escapes, HEAD works", async ({
  request,
}) => {
  expect((await request.get(`${node.ui}assets/missing-1234.js`)).status()).toBe(404);
  expect((await request.get(`${node.ui}%E0%A4%A`)).status()).toBe(400);
  const head = await request.head(`${node.ui}some/app/route`);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-type"]).toContain("text/html");
});

test("ignores malformed saved nodes instead of failing to load", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "jhin.nodes",
      JSON.stringify([{ url: 5 }, { url: "not a url", token: "x", label: "y" }]),
    ),
  );
  await page.goto(`${node.ui}#token=${node.token}`);

  // Settings → Nodes lists the one node, open.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Nodes", exact: true })
    .click();
  await expect(page.getByLabel("Connection open")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^More actions for / })).toHaveCount(1);
});

test("serves only browser files of client plugins", async ({ request }) => {
  // No plugin with this id: 404, and dotfiles or node_modules are never served.
  for (const path of [
    "acme.none/1/index.js",
    "acme.none/1/.env",
    "acme.none/1/node_modules/x.js",
  ]) {
    expect((await request.get(`${node.ui}client/plugins/${path}`)).status()).toBe(404);
  }
});

test("D440: the entry chunk stays under 500 kB; the markdown renderer loads with a message", async ({
  page,
  request,
}) => {
  const html = await (await request.get(node.ui)).text();
  // The page's one module script, whatever the order of its attributes.
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => /\btype="module"/.test(tag));
  expect(scripts).toHaveLength(1);
  const entry = /\bsrc="([^"]+)"/.exec(scripts[0]!)?.[1];
  expect(entry).toBeDefined();
  const source = await (await request.get(new URL(entry!, node.ui).href)).body();
  expect(source.byteLength).toBeLessThan(500 * 1000);
  // Markers the minifier keeps: a class name xterm.js sets, and micromark's own name in its errors.
  const text = source.toString();
  expect(text).not.toContain("xterm-helper-textarea");
  expect(text).not.toContain("micromark");

  // A message brings the renderer: the agent's echo shows its markdown, not the plain text.
  const chunks: string[] = [];
  page.on("request", (sent) => chunks.push(new URL(sent.url()).pathname));
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("some **bold** words");
  await message.press("Enter");
  const reply = page.getByRole("log", { name: "Messages" }).getByRole("article", { name: "Agent" });
  await expect(reply.locator("strong")).toHaveText("bold");
  expect(chunks.some((path) => /\/assets\/markdown-[\w-]+\.js$/.test(path))).toBe(true);
  // No terminal was opened, so xterm.js was never fetched.
  expect(chunks.some((path) => /\/assets\/viewport-[\w-]+\.js$/.test(path))).toBe(false);
  // A long thread opened afresh: its messages may show as plain text first, then as markdown.
  // The timeline is still at its end once the markdown is in.
  await message.fill(
    `a long one\n\n${Array.from({ length: 60 }, (_, i) => `**line ${i}**`).join("\n\n")}`,
  );
  await message.press("Enter");
  await expect(reply.last().locator("strong").last()).toHaveText("line 59");
  await page.reload();
  const log = page.getByRole("log", { name: "Messages" });
  await expect(
    log.getByRole("article", { name: "Agent" }).last().locator("strong").last(),
  ).toHaveText("line 59");
  const gap = await log.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
  // 40 px is the timeline's own "at the end" threshold (useStickToEnd in thread-view.tsx).
  expect(gap).toBeLessThanOrEqual(40);
});
