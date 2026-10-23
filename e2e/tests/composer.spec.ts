import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { threadRow } from "./support/ui.ts";

let node: RunningNode;
test.beforeAll(async () => {
  node = await startNode();
});
test.afterAll(async () => {
  await node.stop();
});

/** A new thread in plan mode whose first turn proposes a plan titled `title` (the fake agent's plan mode). */
async function proposePlan(page: Page, title: string) {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  await page.getByRole("button", { name: "Build mode" }).click();
  await expect(page.getByRole("button", { name: "Plan mode" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(title);
  await message.press("Enter");
  const card = page.getByRole("log", { name: "Messages" }).getByRole("article", { name: title });
  await expect(card).toBeVisible();
  return card;
}

test("shows a proposed plan as T3's card and saves it into the project", async ({ page }, info) => {
  const card = await proposePlan(page, "Add a cache");
  await expect(card.getByText("Plan", { exact: true })).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveText(["Read the code", "Change it", "Test it"]);
  await expect(page.getByRole("region", { name: "Plan ready" })).toContainText("Add a cache");
  await expect(page.getByRole("button", { name: "Implement", exact: true })).toBeVisible();

  const shot = info.outputPath("plan-card.png");
  await page.screenshot({ path: shot });
  await info.attach("plan card", { path: shot, contentType: "image/png" });

  await card.getByRole("button", { name: "Plan actions" }).click();
  await page.getByRole("menuitem", { name: "Save to workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Save plan to workspace" });
  const root = (await dialog.locator("code").textContent()) ?? "";
  const field = dialog.getByRole("textbox", { name: "Workspace path" });
  await expect(field).toHaveValue("add-a-cache.md");
  await field.fill("plans/cache.md");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Plan saved to workspace")).toBeVisible();
  expect(Fs.readFileSync(Path.join(root, "plans", "cache.md"), "utf8")).toBe(
    "# Add a cache\n\n1. Read the code\n2. Change it\n3. Test it\n",
  );
});

test("implements the plan in build mode, or refines it with what was typed", async ({ page }) => {
  await proposePlan(page, "Add a cache");
  // The thread records plan mode: a reload (or another client) still offers the plan.
  await page.reload();
  await expect(page.getByRole("region", { name: "Plan ready" })).toContainText("Add a cache");
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("also tests");
  await expect(page.getByRole("button", { name: "Refine" })).toBeVisible();
  await message.fill("");

  // Enter in an empty composer implements it, as T3's submit button does.
  await message.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" }).last()).toContainText(
    "PLEASE IMPLEMENT THIS PLAN:",
  );
  await expect(log.getByRole("article", { name: "Agent" }).last()).toContainText(
    "Echo: PLEASE IMPLEMENT THIS PLAN:",
  );
  await expect(page.getByRole("button", { name: "Build mode" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Plan ready" })).toBeHidden();
});

test("implements the plan in a new thread titled after it", async ({ page }) => {
  await proposePlan(page, "Rename the API");
  await page.getByRole("button", { name: "Implementation actions" }).click();
  await page.getByRole("menuitem", { name: "Implement in a new thread" }).click();

  await expect(threadRow(page, "Implement Rename the API")).toHaveAttribute("aria-current", "page");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "You" })).toContainText(
    "PLEASE IMPLEMENT THIS PLAN:",
  );
  await expect(log.getByRole("article", { name: "Agent" }).last()).toContainText("Echo:");
  // The thread the plan came from keeps its plan, still offered.
  await threadRow(page, "Rename the API").click();
  await expect(page.getByRole("region", { name: "Plan ready" })).toBeVisible();
});

test("chooses the model's options for a turn: effort, fast mode and Ultrathink", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const traits = page.getByRole("button", { name: "Medium", exact: true });
  await traits.click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await page.getByRole("button", { name: "High", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "On" }).click();
  await expect(page.getByRole("button", { name: "High Fast", exact: true })).toBeVisible();

  const shot = info.outputPath("traits.png");
  await page.getByRole("button", { name: "High Fast", exact: true }).click();
  await page.screenshot({ path: shot });
  await info.attach("traits", { path: shot, contentType: "image/png" });
  await page.keyboard.press("Escape");

  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/options");
  await message.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "Agent" })).toHaveText(
    "Options: effort=high fastMode=true",
  );

  // The thread keeps them for its next turn; Ultrathink goes into the prompt.
  await page.getByRole("button", { name: "High Fast", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Ultrathink" }).click();
  await expect(message).toHaveText("Ultrathink:");
  await expect(page.getByRole("button", { name: "Ultrathink Fast", exact: true })).toBeVisible();
  // As in T3, the prompt carries Ultrathink and the chosen options go with it.
  await message.press("End");
  await message.pressSequentially("/options");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveCount(2);
  await expect(log.getByRole("article", { name: "Agent" }).nth(1)).toHaveText(
    "Options: effort=high fastMode=true prompt=Ultrathink",
  );
});

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

test("attaches any file: uploads it, sends it by id and shows it in the message", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("Hello, world") },
    { name: "dot.png", mimeType: "image/png", buffer: PNG },
  ]);
  const composer = page.getByRole("form", { name: "Composer" });
  await expect(composer.getByText("notes.md")).toBeVisible();
  await expect(composer.getByRole("img", { name: "dot.png" })).toBeVisible();
  // Uploaded: the file row shows its size instead of its progress.
  await expect(composer.getByText("1 KB")).toBeVisible();

  const shot = info.outputPath("attachments-composer.png");
  await page.screenshot({ path: shot });
  await info.attach("attachments in the composer", { path: shot, contentType: "image/png" });

  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/attachments");
  await message.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "Agent" })).toHaveText(
    `Attached: notes.md (12 bytes: Hello, world), dot.png (${PNG.length} bytes)`,
  );
  const sent = log.getByRole("article", { name: "You" });
  await expect(sent.getByRole("img", { name: "dot.png" })).toBeVisible();
  await expect(sent.getByRole("button", { name: "Download notes.md" })).toBeVisible();
  const download = page.waitForEvent("download");
  await sent.getByRole("button", { name: "Download notes.md" }).click();
  expect((await download).suggestedFilename()).toBe("notes.md");

  const sentShot = info.outputPath("attachments-message.png");
  await page.screenshot({ path: sentShot });
  await info.attach("attachments in the message", { path: sentShot, contentType: "image/png" });
});

test("previews an attached file in the composer and the message, shows videos and queued thumbnails", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Release notes\n\nHello, world"),
    },
    // No type: the composer types a video by its name, as T3 does.
    { name: "clip.webm", mimeType: "", buffer: Buffer.from("not really a video") },
  ]);
  const composer = page.getByRole("form", { name: "Composer" });
  await expect(composer.getByRole("button", { name: "Play clip.webm" })).toBeVisible();
  await expect(composer.getByText("1 KB")).toBeVisible();

  // The draft's file opens in T3's preview: rendered markdown, under "Draft".
  await composer.getByRole("button", { name: "notes.md", exact: true }).click();
  const draftPreview = page.getByRole("dialog", { name: "notes.md" });
  await expect(draftPreview.getByRole("heading", { name: "Release notes" })).toBeVisible();
  await expect(draftPreview.getByText("Draft")).toBeVisible();
  await expect(draftPreview.getByRole("button", { name: "Remove from draft" })).toBeVisible();
  await draftPreview.getByRole("button", { name: "Close" }).click();
  await expect(draftPreview).toBeHidden();

  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/attachments");
  await message.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "Agent" })).toContainText(
    "notes.md (29 bytes: # Release notes",
  );
  await expect(log.getByRole("article", { name: "Agent" })).toContainText("clip.webm (18 bytes)");
  const sent = log.getByRole("article", { name: "You" });
  await expect(sent.getByRole("button", { name: "Play clip.webm" })).toBeVisible();

  // The sent file opens in the same preview, its bytes read back from the node.
  await sent.getByRole("button", { name: "Preview notes.md" }).click();
  const preview = page.getByRole("dialog", { name: "notes.md" });
  await expect(preview.getByRole("heading", { name: "Release notes" })).toBeVisible();
  await expect(preview.getByText("Attachment", { exact: true })).toBeVisible();
  const shot = info.outputPath("attachment-preview.png");
  await page.screenshot({ path: shot });
  await info.attach("attachment preview", { path: shot, contentType: "image/png" });
  // Its source, highlighted as T3 shows it.
  await preview.getByRole("button", { name: "Show markdown source" }).click();
  await expect(preview.getByRole("button", { name: "Show rendered markdown" })).toBeVisible();
  await expect(preview.getByText("Hello, world")).toBeVisible();
  const sourceShot = info.outputPath("attachment-preview-source.png");
  await page.screenshot({ path: sourceShot });
  await info.attach("attachment preview, source", { path: sourceShot, contentType: "image/png" });
  await preview.getByRole("button", { name: "Close" }).click();
  await expect(preview).toBeHidden();

  // A queued message's image shows as T3's thumbnail, read from the node by its id.
  await message.fill("/hold on");
  await message.press("Enter");
  await expect(log.getByRole("article", { name: "Agent" }).last()).toHaveText("Holding");
  await page
    .locator('input[type="file"]')
    .setInputFiles([{ name: "dot.png", mimeType: "image/png", buffer: PNG }]);
  await expect(composer.getByRole("img", { name: "dot.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();
  await message.press("Enter");
  const queued = page.getByRole("region", { name: "1 queued message" });
  await expect(queued.locator('img[alt="dot.png"]')).toHaveAttribute("src", /^blob:/);
  const queueShot = info.outputPath("queued-thumbnail.png");
  await page.screenshot({ path: queueShot });
  await info.attach("queued thumbnail", { path: queueShot, contentType: "image/png" });
});

test("attaches a large paste as pasted-text.txt", async ({ page }) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.focus();
  const large = "x".repeat(40 * 1024);
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, large);
  await expect(page.getByText("Large paste attached as pasted-text.txt")).toBeVisible();
  await expect(message).toHaveText("");
  await expect(
    page.getByRole("form", { name: "Composer" }).getByText("pasted-text.txt"),
  ).toBeVisible();
  await message.fill("/attachments");
  await message.press("Enter");
  await expect(page.getByRole("article", { name: "Agent" })).toContainText(
    "pasted-text.txt (40960 bytes: xxxx",
  );
});

test("offers commands, skills and files from / $ and @, and inserts what is picked", async ({
  page,
}, info) => {
  // The scratch project's folder: what "@" searches.
  const scratch = Path.join(node.home, "data", "jhin.threads", "scratch");
  Fs.mkdirSync(Path.join(scratch, "src"), { recursive: true });
  Fs.writeFileSync(Path.join(scratch, "src", "app.ts"), "export {};\n");
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();

  await message.pressSequentially("/");
  const commands = page.getByRole("listbox", { name: "Commands" });
  await expect(commands.getByRole("option")).toHaveText([
    /\/model/,
    /\/plan/,
    /\/default/,
    /\/usage-limits/,
    /\/review/,
    /\/skill:Deploy/,
  ]);
  const shot = info.outputPath("slash-menu.png");
  await page.screenshot({ path: shot });
  await info.attach("slash menu", { path: shot, contentType: "image/png" });
  await message.pressSequentially("rev");
  await expect(commands.getByRole("option")).toHaveText([/\/review/]);
  // The menu is the editor's list, its highlighted option the active one (D1348).
  await expect(message).toHaveAttribute("aria-controls", (await commands.getAttribute("id"))!);
  // The highlighted option is the one the editor names (waited for, as the names change).
  const highlighted = commands.locator('[role="option"][aria-selected="true"]');
  await expect(highlighted).toHaveText(/\/review/);
  await expect(message).toHaveAttribute(
    "aria-activedescendant",
    (await highlighted.getAttribute("id"))!,
  );
  await message.press("Enter");
  await expect(commands).toBeHidden();
  await expect(message).not.toHaveAttribute("aria-activedescendant");
  await expect(message).toHaveText("/review");

  // $ offers skills; the pick is a chip that sends as $deploy.
  await message.press("End");
  await message.pressSequentially(" then $dep");
  const skills = page.getByRole("listbox", { name: "Skills" });
  await expect(skills.getByRole("option")).toHaveText([/Deploy/]);
  await message.press("Enter");
  await expect(message.locator("[data-skill='deploy']")).toBeVisible();

  // @ searches the project's files.
  await message.pressSequentially("@app");
  const files = page.getByRole("listbox", { name: "Files and folders" });
  await expect(files.getByRole("option").first()).toContainText("app.ts");
  await message.press("ArrowDown");
  await message.press("ArrowUp");
  await message.press("Tab");
  await expect(message.locator("[data-mention='src/app.ts']")).toHaveText("app.ts");
  await message.press("Escape");

  await message.press("Enter");
  // The agent got the markdown: the file link renders as a link in its echo.
  const answer = page
    .getByRole("log", { name: "Messages" })
    .getByRole("article", { name: "Agent" });
  await expect(answer).toContainText("Echo: /review");
  await expect(answer).toContainText("$deploy");
  await expect(answer.getByRole("link", { name: "app.ts" })).toHaveAttribute("href", "src/app.ts");
});

test("shows T3's chips with their details: a file's preview and a skill's instructions", async ({
  page,
}, info) => {
  const scratch = Path.join(node.home, "data", "jhin.threads", "scratch");
  Fs.mkdirSync(Path.join(scratch, "src"), { recursive: true });
  Fs.writeFileSync(Path.join(scratch, "src", "app.ts"), "export const port = 8080;\n");
  Fs.mkdirSync(Path.join(scratch, ".claude", "skills", "deploy"), { recursive: true });
  Fs.writeFileSync(
    Path.join(scratch, ".claude", "skills", "deploy", "SKILL.md"),
    "# Deploying\n\nRun the release script.\n",
  );
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await message.pressSequentially("check @app");
  // The file, not a thread whose title holds "app" (an earlier test's), which comes first.
  await page
    .getByRole("listbox", { name: "Files and folders" })
    .getByRole("option")
    .filter({ hasText: "app.ts", hasNotText: "Thread" })
    .first()
    .click();
  await expect(message.locator("[data-mention='src/app.ts']")).toBeVisible();
  await message.press("End");
  await message.pressSequentially(" ");
  await message.pressSequentially("with $dep");
  await expect(page.getByRole("listbox", { name: "Skills" }).getByRole("option")).toHaveText([
    /Deploy/,
  ]);
  await message.press("Enter");

  // A file chip shows its file in the panel beside the thread (D1342).
  await page.getByRole("button", { name: "Preview src/app.ts" }).click();
  const preview = page.getByRole("complementary", { name: "File preview" });
  await expect(preview).toContainText("export const port = 8080;");
  await preview.getByRole("button", { name: "Close app.ts" }).click();
  await expect(preview).toBeHidden();

  // A skill chip: its description, and its SKILL.md behind "View instructions" (D1004).
  await page.getByRole("button", { name: "Skill Deploy. Show details" }).click();
  await expect(page.getByText("Deploy the app")).toBeVisible();
  const shot = info.outputPath("skill-chip.png");
  await page.screenshot({ path: shot });
  await info.attach("skill chip", { path: shot, contentType: "image/png" });
  await page.getByRole("button", { name: "View instructions" }).click();
  const instructions = page.getByRole("dialog", { name: "SKILL.md" });
  await expect(instructions.getByRole("heading", { name: "Deploying" })).toBeVisible();
  await expect(page.getByText("Deploy the app")).toBeHidden();
  const dialogShot = info.outputPath("skill-instructions.png");
  await page.screenshot({ path: dialogShot });
  await info.attach("skill instructions", { path: dialogShot, contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(instructions).toBeHidden();

  // Sending the draft with its file beside it opens the new thread with the file still there.
  await page.getByRole("button", { name: "Preview src/app.ts" }).click();
  await expect(preview).toContainText("export const port = 8080;");
  await message.press("End");
  await message.press("Enter");
  await expect(
    page.getByRole("log", { name: "Messages" }).getByRole("article", { name: "You" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/[#&]t=/);
  await expect(preview).toContainText("export const port = 8080;");
});

test("shows a sent message's file and skill chips, and its file beside the thread", async ({
  page,
}, info) => {
  const scratch = Path.join(node.home, "data", "jhin.threads", "scratch");
  Fs.mkdirSync(Path.join(scratch, "docs"), { recursive: true });
  Fs.writeFileSync(Path.join(scratch, "docs", "plan.md"), "# The plan\n\nShip **on Friday**.\n");
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  // The fake agent offers `deploy` (and no `ship`, which stays text).
  await message.fill("read [plan.md](docs/plan.md) then $deploy it, not $ship");
  await message.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  const sent = log.getByRole("article", { name: "You" });
  // The file and the skill as T3 shows them in a sent message (D1341).
  await expect(sent.getByRole("button", { name: "Preview docs/plan.md" })).toBeVisible();
  await expect(sent.getByText("Deploy", { exact: true })).toBeVisible();
  await expect(sent).not.toContainText("$deploy");
  await expect(sent).toContainText("not $ship");

  await sent.getByRole("button", { name: "Preview docs/plan.md" }).click();
  const preview = page.getByRole("complementary", { name: "File preview" });
  await expect(preview.getByRole("heading", { name: "The plan" })).toBeVisible();
  await expect(preview).toContainText("docs");
  const shot = info.outputPath("file-panel.png");
  await page.screenshot({ path: shot });
  await info.attach("sent message chips and the file panel", {
    path: shot,
    contentType: "image/png",
  });
  // The panel is a place in the URL: it is there after a reload.
  await page.reload();
  await expect(preview.getByRole("heading", { name: "The plan" })).toBeVisible();
  await preview.getByRole("button", { name: "Close plan.md" }).click();
  await expect(preview).toBeHidden();
  await expect(sent.getByRole("button", { name: "Preview docs/plan.md" })).toBeVisible();
});

test("spaces a heading as T3 does, and shows a code block's language with its icon", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await message.pressSequentially("intro");
  await message.press("Shift+Enter");
  await message.pressSequentially("## Plan");
  const heading = message.locator("h2");
  await expect(heading).toHaveText("Plan");
  // T3's `.composer-tiptap` headings: 1.25rem above, 0.5rem below (D1347).
  expect(
    await heading.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.marginTop, style.marginBottom];
    }),
  ).toEqual(["20px", "8px"]);
  await message.press("Shift+Enter");
  await message.pressSequentially("```ts");
  await message.press("Enter");
  await message.pressSequentially("const a = 1;");
  const language = page.getByRole("combobox", { name: "Code language: TypeScript" });
  await expect(language.locator("svg[data-pierre-icon]")).toBeVisible();
  const shot = info.outputPath("editor-details.png");
  await page.screenshot({ path: shot });
  await info.attach("heading spacing and the language icon", {
    path: shot,
    contentType: "image/png",
  });
});

test("cites a selection of the agent's answer, with a comment, as T3's quote", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("cache the results");
  await message.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  const answer = log.getByRole("article", { name: "Agent" });
  await expect(answer).toHaveText("Echo: cache the results");
  await expect(answer).toHaveAttribute("aria-busy", "false");
  // Its markdown, not the plain text shown until the renderer loads, which it then replaces.
  await expect(answer.locator("p")).toHaveText("Echo: cache the results");

  // A selection in the answer offers "Cite" (D1012).
  await answer.evaluate((article) => {
    // The answer's text node, however it is rendered (markdown or its plain text first).
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let text: Text | null = null;
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes("the results")) {
        text = walker.currentNode as Text;
        break;
      }
    }
    const start = text!.data.indexOf("the results");
    const range = document.createRange();
    range.setStart(text!, start);
    range.setEnd(text!, start + "the results".length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });

  await page.getByRole("button", { name: "Cite selection in composer", exact: true }).click();
  const chip = message.getByRole("button", { name: "View cited assistant text: the results" });
  await expect(chip).toBeVisible();

  // Its comment (D1011): the chip then shows it.
  await message.getByRole("button", { name: "Add comment to citation" }).click();
  await page.getByRole("textbox", { name: "Comment on selected text" }).fill("in memory?");
  await page.getByRole("textbox", { name: "Comment on selected text" }).press("Enter");
  await expect(
    message.getByRole("button", { name: "View cited assistant text: in memory?" }),
  ).toBeVisible();
  const composerShot = info.outputPath("citation-composer.png");
  await page.screenshot({ path: composerShot });
  await info.attach("citation in the composer", { path: composerShot, contentType: "image/png" });

  // The agent reads T3's quote block; the sent message shows the quote, and its source.
  await message.press("End");
  await message.pressSequentially("please");
  await message.press("Enter");
  await expect(answer.last()).toContainText("[assistant-quote-1]");
  await expect(answer.last()).toContainText("<assistant_citations>");
  const sent = log.getByRole("article", { name: "You" }).last();
  await sent
    .getByRole("button", { name: "Quoted assistant text: in memory?. Show details" })
    .click();
  await expect(page.getByRole("dialog").getByText("the results", { exact: true })).toBeVisible();
  const sentShot = info.outputPath("citation-sent.png");
  await page.screenshot({ path: sentShot });
  await info.attach("citation in the message", { path: sentShot, contentType: "image/png" });
  await page.getByRole("button", { name: "Go to source" }).click();
  // The quote's text in the answer, selected as it was (the click selects it at once).
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("the results");
});

test("switches to plan mode with /plan sent alone, and dismisses a menu with Escape", async ({
  page,
}) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  // The agent's modes are known once its toggle shows.
  await expect(page.getByRole("button", { name: "Build mode" })).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await message.pressSequentially("/pl");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await message.press("Escape");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeHidden();
  await message.pressSequentially("an");
  await message.press("Enter");
  await expect(page.getByRole("button", { name: "Plan mode" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(message).toHaveText("");
});

test("shows the agent's usage limits on /usage-limits, and a usage-limit failure with its reset time", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  await expect(page.getByRole("button", { name: "Build mode" })).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await message.pressSequentially("/usage");
  await expect(page.getByRole("listbox", { name: "Commands" }).getByRole("option")).toHaveText([
    /\/usage-limits.*Show this provider's usage limits/,
  ]);
  await message.press("Escape");
  await message.pressSequentially("-limits");
  await message.press("Enter");
  // Answered by the client: the banner shows and nothing is sent.
  const banner = page.getByRole("alert").filter({ hasText: "Usage limits" });
  await expect(banner).toContainText("Fake agent");
  await expect(banner.getByRole("img", { name: /^Session: 75% left/ })).toBeVisible();
  await expect(banner.getByRole("img", { name: /^Weekly: 40% left/ })).toBeVisible();
  await expect(banner).toContainText(/resets in 1h 59m|resets in 2h 0m/);
  await expect(message).toHaveText("");
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article")).toHaveCount(0);
  const shot = info.outputPath("usage-limits.png");
  await page.screenshot({ path: shot });
  await info.attach("usage limits", { path: shot, contentType: "image/png" });
  await banner.getByRole("button", { name: "Dismiss usage limits" }).click();
  await expect(banner).toBeHidden();

  await message.fill("/limit");
  await message.press("Enter");
  // T3's warning row, with the time to retry after instead of the agent's message.
  await expect(page.getByText(/^Usage limit reached\. Retry after .+\.$/)).toBeVisible();
  await expect(page.getByText("Turn failed")).toHaveCount(0);
  // The sidebar says "Limited", not "Failed" (t3-parity.md D1307).
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: /, Limited(, |$)/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /, Failed(, |$)/ })).toHaveCount(0);
  // T3's recovery banner (t3-parity.md D1312): resume at the reset, or snooze until then.
  const recovery = page.getByRole("region", { name: "Usage limit reached" });
  await expect(recovery).toContainText(/^Usage limit reached.*Resets /);
  await recovery.getByRole("button", { name: "Resume at reset" }).click();
  await expect(recovery.getByRole("button", { name: "Cancel auto-resume" })).toBeVisible();
  await recovery.getByRole("button", { name: "Snooze until reset" }).click();
  await expect(recovery.getByRole("button", { name: "Snooze until reset" })).toHaveCount(0);
  const failed = info.outputPath("usage-limit-failure.png");
  await page.screenshot({ path: failed });
  await info.attach("usage limit failure", { path: failed, contentType: "image/png" });
  // "Resume thread" goes on now (D1311): T3's continuation is the next turn.
  await page.getByRole("button", { name: "Resume thread" }).click();
  await expect(
    page
      .getByRole("log", { name: "Messages" })
      .getByText("Continue where you left off.", { exact: true }),
  ).toBeVisible();
  await expect(recovery).toBeHidden();
});

test("asks for an app's access as T3's App access approval, without a session allowance", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/access GitHub");
  await message.press("Enter");
  const approval = page.getByRole("group", { name: "App access approval" });
  await expect(approval).toContainText("GitHub");
  await expect(approval.getByLabel("App access request")).toHaveText(
    "Allow ChatGPT to use GitHub?",
  );
  await page.getByRole("button", { name: "More approval options" }).click();
  await expect(page.getByRole("menuitem", { name: "Cancel" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Always allow this session" })).toHaveCount(0);
  const shot = info.outputPath("app-access.png");
  await page.screenshot({ path: shot });
  await info.attach("app access approval", { path: shot, contentType: "image/png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.getByRole("log", { name: "Messages" }).getByRole("article", { name: "Agent" }),
  ).toHaveText("GitHub allowed");
});

test("offers an app's own allowances and T3's Always allow", async ({ page }, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/access-always Drive");
  await message.press("Enter");
  await expect(page.getByRole("group", { name: "App access approval" })).toContainText("Drive");
  await page.getByRole("button", { name: "More approval options" }).click();
  // The labels the app gives its allowances (providers.md D1316).
  await expect(page.getByRole("menuitem")).toHaveText([
    "Allow for this chat",
    "Always allow Drive",
    "Cancel",
  ]);
  const shot = info.outputPath("always-allow.png");
  await page.screenshot({ path: shot });
  await info.attach("always allow", { path: shot, contentType: "image/png" });
  await page.getByRole("menuitem", { name: "Always allow Drive" }).click();
  await expect(
    page.getByRole("log", { name: "Messages" }).getByRole("article", { name: "Agent" }),
  ).toHaveText("Drive always allowed");
});

test("sends /feedback to the agent's maker and shows T3's banner", async ({ page }, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("hello");
  await message.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article", { name: "Agent" })).toHaveText("Echo: hello");
  // The composer knows the thread's agent (its model's name comes from it): it takes feedback.
  await expect(
    page.getByRole("form", { name: "Composer" }).getByRole("button", { name: "Model" }),
  ).toHaveText("Echo");
  await message.fill("/feedback the diff was wrong");
  await message.press("Enter");
  // Answered by the maker, not the agent (providers.md D1317).
  const banner = page.getByRole("status", { name: "Feedback" });
  await expect(banner).toContainText("Feedback sent to OpenAI");
  await expect(banner).toContainText(/Thread ID: feedback-/);
  await expect(banner.getByRole("button", { name: "Copy ID" })).toBeVisible();
  await expect(message).toHaveText("");
  await expect(log.getByRole("article", { name: "Agent" })).toHaveCount(1);
  const shot = info.outputPath("feedback.png");
  await page.screenshot({ path: shot });
  await info.attach("feedback", { path: shot, contentType: "image/png" });
  await banner.getByRole("button", { name: "Dismiss feedback notice" }).click();
  await expect(banner).toBeHidden();
  await message.fill("/feedback fail");
  await message.press("Enter");
  await expect(page.getByRole("status", { name: "Feedback" })).toContainText(
    "Could not send feedback to OpenAI",
  );
});

test("shows an MCP app a tool call returned, and asks before the app calls a tool", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/app board");
  await message.press("Enter");
  // The app in its sandboxed frame, under the call (providers.md D1403).
  const app = page.getByRole("group", { name: "board app" });
  const frame = page.frameLocator('iframe[title="board: show_board"]');
  await expect(frame.getByText("Tool said: Board shown")).toBeVisible();
  await expect(app.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  await frame.getByRole("button", { name: "Move card" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Allow board to run move_card?");
  const shot = info.outputPath("mcp-app.png");
  await page.screenshot({ path: shot });
  await info.attach("mcp app", { path: shot, contentType: "image/png" });
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(frame.getByText('Moved: move_card done with {"card":3}')).toBeVisible();
});

test("shows the thread's goal above the composer, and resumes and clears it", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/goal Ship the release");
  await message.press("Enter");
  const goal = page.getByRole("region", { name: "Goal" });
  await expect(goal).toContainText("Goal paused · 12k tokens · 2m 5s");
  await expect(goal).toContainText("Ship the release");
  const shot = info.outputPath("goal.png");
  await page.screenshot({ path: shot });
  await info.attach("goal", { path: shot, contentType: "image/png" });
  await goal.getByRole("button", { name: "Resume" }).click();
  await expect(goal).toContainText("Goal complete · 20k tokens · 2m 5s");
  await expect(goal.getByRole("button", { name: "Resume" })).toHaveCount(0);
  await goal.getByRole("button", { name: "Clear" }).click();
  await expect(goal).toBeHidden();
});

test("highlights a code block in the prompt, picks its language and indents with Tab", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await message.pressSequentially("```ts");
  await message.press("Enter");
  await message.pressSequentially("const total = 1;");
  await expect(message.getByText("const", { exact: true })).toHaveClass(/composer-code-token/);
  await message.press("Home");
  await message.press("Tab");
  await expect(message.locator("pre")).toHaveText("  const total = 1;");
  await expect(message).toBeFocused();

  await page.getByRole("combobox", { name: "Code language: TypeScript" }).click();
  await page.getByRole("combobox", { name: "Search languages" }).fill("py");
  const shot = info.outputPath("code-block-language.png");
  await page.screenshot({ path: shot });
  await info.attach("code block language picker", { path: shot, contentType: "image/png" });
  await page.getByRole("option", { name: "Python" }).click();
  await expect(page.getByRole("combobox", { name: "Code language: Python" })).toBeVisible();
  const highlighted = info.outputPath("code-block.png");
  await page.screenshot({ path: highlighted });
  await info.attach("highlighted code block", { path: highlighted, contentType: "image/png" });
});

test("hides skills from the / menu with T3's setting, and still offers them after $", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Show skills in slash menu" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  try {
    const shot = info.outputPath("skills-setting.png");
    await page.screenshot({ path: shot });
    await info.attach("show skills in slash menu", { path: shot, contentType: "image/png" });

    await page.goto(`${node.ui}#token=${node.token}`);
    await page.getByRole("button", { name: "Start a thread" }).click();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.click();
    await message.pressSequentially("/");
    const commands = page.getByRole("listbox", { name: "Commands" });
    await expect(commands.getByRole("option")).toHaveText([
      /\/model/,
      /\/plan/,
      /\/default/,
      /\/usage-limits/,
      /\/review/,
    ]);
    await message.press("Escape");
    await message.pressSequentially(" then $dep");
    await expect(page.getByRole("listbox", { name: "Skills" }).getByRole("option")).toHaveText([
      /Deploy/,
    ]);
  } finally {
    // The node is shared with the other specs: put the default back even on a failure.
    await page.goto(`${node.ui}#token=${node.token}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Show skills in slash menu" }).click();
    await expect(page.getByRole("switch", { name: "Show skills in slash menu" })).toBeChecked();
  }
});

test("shows a heading and a task list in the prompt, and ticks a task", async ({ page }, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Start a thread" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await message.pressSequentially("# Plan");
  await message.press("Shift+Enter");
  await message.pressSequentially("- [ ] read the code");
  await message.press("Shift+Enter");
  await message.pressSequentially("test it");
  await expect(message.getByRole("heading", { name: "Plan" })).toBeVisible();
  const boxes = message.getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await boxes.first().click();
  await expect(boxes.first()).toBeChecked();
  const shot = info.outputPath("blocks.png");
  await page.screenshot({ path: shot });
  await info.attach("heading and task list", { path: shot, contentType: "image/png" });
});

test("mentions a pull request after # and another thread after @, as context records the agent gets", async ({
  page,
}, info) => {
  // A node whose GitHub CLI lists two pull requests of the project's repository.
  const own = await startNode({
    setup: (home) => {
      const dir = Path.join(home, "fake-gh");
      Fs.mkdirSync(dir, { recursive: true });
      const pr = (number: number, title: string, state: string, updatedAt: string) => ({
        number,
        title,
        url: `https://github.com/acme/app/pull/${number}`,
        state,
        isDraft: false,
        headRefName: `branch-${number}`,
        baseRefName: "main",
        updatedAt,
      });
      Fs.writeFileSync(
        Path.join(dir, "list.json"),
        JSON.stringify([
          pr(12, "Add a cache", "OPEN", "2026-10-20T10:00:00Z"),
          pr(9, "Greet by name", "MERGED", "2026-10-18T10:00:00Z"),
        ]),
      );
      const gh = Path.join(dir, "gh");
      Fs.writeFileSync(
        gh,
        `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ] && [ "$3" = "--state" ]; then cat "${dir}/list.json"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[]'; exit 0; fi
echo "no pull requests found" >&2
exit 1
`,
        { mode: 0o755 },
      );
      const file = Path.join(home, ".jhin", "config.jsonc");
      const config = JSON.parse(Fs.readFileSync(file, "utf8"));
      Fs.writeFileSync(
        file,
        JSON.stringify({ ...config, "jhin.source-control": { ghPath: gh } }, null, 2),
      );
    },
  });
  try {
    const repo = Path.join(own.home, "acme");
    Fs.mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      ChildProcess.execFileSync("git", args, {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    git("init", "--quiet", "--initial-branch=main");
    git("remote", "add", "origin", "https://github.com/acme/app.git");
    const project = await own.client().call<{ id: string }>("projects.create", { path: repo });
    await own.client().call("threads.create", { projectId: project.id, title: "Fix the cache" });
    await own.client().call("threads.create", { projectId: project.id, title: "Release notes" });

    await page.goto(`${own.ui}#token=${own.token}`);
    await threadRow(page, "Release notes").click();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.click();

    // "#" lists the repository's pull requests, most recently updated first, with their state.
    await message.pressSequentially("Compare #");
    const pullRequests = page.getByRole("listbox", { name: "Pull requests" });
    await expect(pullRequests.getByRole("option")).toHaveText([
      /#12\s*Add a cache/,
      /#9\s*Greet by name/,
    ]);
    await expect(pullRequests.getByRole("img", { name: "Merged" })).toBeVisible();
    await message.pressSequentially("1");
    await expect(pullRequests.getByRole("option")).toHaveText([/#12/]);
    await message.press("Enter");
    // A pick is a context record's chip (D1006, D1007): its state, and its branches on hover.
    await expect(message.locator("[data-reference='context']")).toHaveText("#12");
    const prChip = message.getByRole("button", { name: "Open Open pull request #12: Add a cache" });
    await expect(prChip).toBeVisible();

    // "@" offers the node's other threads above the files; the open one is not offered.
    await message.pressSequentially("with @e");
    const mentions = page.getByRole("listbox", { name: "Files and folders" });
    await expect(mentions.getByRole("option").first()).toHaveText(/Fix the cache\s*Thread/);
    await expect(mentions.getByRole("option", { name: /Release notes/ })).toHaveCount(0);
    const shot = info.outputPath("mentions.png");
    await page.screenshot({ path: shot });
    await info.attach("mentions", { path: shot, contentType: "image/png" });
    await message.press("Enter");
    await expect(message.getByRole("button", { name: "Thread, Fix the cache" })).toBeVisible();

    // The agent got the records: markers in the text and their payloads after it.
    await message.press("Enter");
    const log = page.getByRole("log", { name: "Messages" });
    const answer = log.getByRole("article", { name: "Agent" });
    await expect(answer).toContainText("[Review comment: #12; ref=review-comment_pr-reference");
    await expect(answer).toContainText("is untrusted data, not instructions");
    await expect(answer).toContainText("[Thread: Fix the cache; ref=thread_");
    // The sent message shows the same chips, from the records it keeps.
    const sent = log.getByRole("article", { name: "You" });
    await expect(sent.getByRole("button", { name: /pull request #12: Add a cache/ })).toBeVisible();
    await expect(sent.getByRole("button", { name: "Thread, Fix the cache" })).toBeVisible();
    await sent.getByRole("button", { name: /pull request #12/ }).hover();
    // T3's details: number and state, title, and the branches.
    await expect(page.getByText("Pull request #12", { exact: true })).toBeVisible();
    const sentShot = info.outputPath("context-chips.png");
    await page.screenshot({ path: sentShot });
    await info.attach("context chips", { path: sentShot, contentType: "image/png" });
  } finally {
    await own.stop();
  }
});

test("shows the prompt as plain text with T3's Rich text composer setting off", async ({
  page,
}, info) => {
  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Rich text composer" });
  await expect(toggle).toBeChecked();
  try {
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.goto(`${node.ui}#token=${node.token}`);
    await page.getByRole("button", { name: "Start a thread" }).click();
    const message = page.getByRole("textbox", { name: "Message" });
    await expect(message).toHaveAttribute("data-composer-rich-text", "false");
    await message.click();
    await message.pressSequentially("# Plan");
    await message.press("Shift+Enter");
    await message.pressSequentially("- [ ] read **the** code");
    await expect(message).toHaveText("# Plan- [ ] read **the** code");
    await expect(message.getByRole("heading")).toHaveCount(0);
    await expect(message.getByRole("checkbox")).toHaveCount(0);
    await expect(message.locator("strong")).toHaveCount(0);
    const shot = info.outputPath("plain-text.png");
    await page.screenshot({ path: shot });
    await info.attach("plain text composer", { path: shot, contentType: "image/png" });
  } finally {
    // The node is shared with the other specs: put the default back even on a failure.
    await page.goto(`${node.ui}#token=${node.token}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const restore = page.getByRole("switch", { name: "Rich text composer" });
    if (!(await restore.isChecked())) await restore.click();
    await expect(restore).toBeChecked();
  }
});
