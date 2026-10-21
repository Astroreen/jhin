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
    /\/review/,
    /\/skill:Deploy/,
  ]);
  const shot = info.outputPath("slash-menu.png");
  await page.screenshot({ path: shot });
  await info.attach("slash menu", { path: shot, contentType: "image/png" });
  await message.pressSequentially("rev");
  await expect(commands.getByRole("option")).toHaveText([/\/review/]);
  await message.press("Enter");
  await expect(commands).toBeHidden();
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
