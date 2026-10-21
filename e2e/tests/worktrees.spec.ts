import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { threadRow } from "./support/ui.ts";

const running: RunningNode[] = [];
test.afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

const git = (cwd: string, ...args: string[]) =>
  ChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D250–D255: a draft starts its thread in a new worktree; deleting the thread offers to delete it", async ({
  page,
}, info) => {
  const node = await startNode({ mode: "ui" });
  running.push(node);
  const dir = Path.join(node.home, "acme");
  Fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  Fs.writeFileSync(Path.join(dir, "README.md"), "acme\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "first");
  await node.client().call("projects.create", { path: dir });

  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("option", { name: "New thread in...", exact: true }).click();
  await palette.getByRole("option", { name: /^acme/ }).click();
  await expect(palette).toBeHidden();

  // T3's workspace menu under the composer: a new worktree from main.
  const workspace = page.getByRole("button", { name: "Workspace" });
  await expect(workspace).toHaveText(/Current checkout/);
  await workspace.click();
  await page.getByRole("menuitemradio", { name: "New worktree" }).click();
  await expect(workspace).toHaveText(/New worktree/);
  await expect(page.getByRole("combobox", { name: "Branch From main" })).toBeVisible();
  await shot(page, info, "worktree-draft");

  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("/write notes.txt in a worktree");
  await message.press("Enter");

  const card = threadRow(page, "/write notes.txt in a worktree");
  const icon = card.getByRole("img", {
    name: /^Worktree: jhin-[0-9a-f]{8} \(jhin\/[0-9a-f]{8}\)$/,
  });
  await expect(icon).toBeVisible();
  const label = (await icon.getAttribute("aria-label"))!;
  const folder = /^Worktree: (\S+)/.exec(label)![1]!;
  const [created] = await node.client().call<{ worktreePath?: string }[]>("threads.list", {});
  const path = created!.worktreePath!;
  // Under the node's worktrees directory, as <repository>/<branch> (D250).
  expect(path.endsWith(Path.join("worktrees", "acme", folder))).toBe(true);
  await expect(page.getByRole("img", { name: "Workspace: Worktree" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Changed files" })).toContainText("1 changed file");
  expect(Fs.readFileSync(Path.join(path, "notes.txt"), "utf8")).toBe("in a worktree\n");
  expect(Fs.existsSync(Path.join(dir, "notes.txt"))).toBe(false);
  await shot(page, info, "worktree-thread");

  // Reverting to before a message, files too (D257): the worktree is the thread's alone.
  await message.fill("/write later.txt two");
  await message.press("Enter");
  await expect(page.getByRole("region", { name: "Changed files" })).toHaveCount(2);
  expect(Fs.existsSync(Path.join(path, "later.txt"))).toBe(true);
  const log = page.getByRole("log", { name: "Messages" });
  await log.getByRole("article", { name: "You" }).nth(1).hover();
  await log.getByRole("button", { name: "Edit from here" }).nth(1).click();
  const rewind = page.getByRole("alertdialog", { name: "Edit from here?" });
  await expect(rewind.getByRole("button", { name: "Revert and keep changes" })).toBeVisible();
  await shot(page, info, "worktree-revert");
  await rewind.getByRole("button", { name: "Revert files too" }).click();
  await expect(log.getByRole("article", { name: "You" })).toHaveCount(1);
  await expect(message).toHaveValue("/write later.txt two");
  expect(Fs.existsSync(Path.join(path, "later.txt"))).toBe(false);
  expect(Fs.readFileSync(Path.join(path, "notes.txt"), "utf8")).toBe("in a worktree\n");
  await message.fill("");

  // Deleting the thread: T3 asks about the worktree only it used.
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  const question = page.getByRole("alertdialog", { name: "Delete the worktree too?" });
  await expect(question).toContainText("This thread is the only one linked to this worktree:");
  await expect(question).toContainText(folder);
  await shot(page, info, "worktree-delete");
  await question.getByRole("button", { name: "Delete worktree" }).click();
  await expect(card).toHaveCount(0);
  // The thread is left once its worktree is gone too.
  await expect(page).not.toHaveURL(/[#&]t=/);
  expect(Fs.existsSync(path)).toBe(false);
  expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(folder);
});
