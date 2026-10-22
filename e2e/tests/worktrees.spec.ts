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
  // T3's composer.workspace opens it from the keyboard (D906).
  await page.keyboard.press("ControlOrMeta+Shift+X");
  await expect(page.getByRole("menuitemradio", { name: "New worktree" })).toBeVisible();
  await shot(page, info, "workspace-menu-shortcut");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitemradio", { name: "New worktree" })).toBeHidden();
  // And composer.branch opens the branch picker (D907).
  await page.keyboard.press("ControlOrMeta+Shift+G");
  await expect(page.getByRole("combobox", { name: "Search refs" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Search refs" })).toBeHidden();
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
  await expect(message).toHaveText("/write later.txt two");
  expect(Fs.existsSync(Path.join(path, "later.txt"))).toBe(false);
  expect(Fs.readFileSync(Path.join(path, "notes.txt"), "utf8")).toBe("in a worktree\n");
  await message.fill("");

  // A new draft of the project takes that worktree with composer.previous-worktree (D907).
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  await palette.getByRole("option", { name: "New thread in...", exact: true }).click();
  await palette.getByRole("option", { name: /^acme/ }).click();
  await expect(palette).toBeHidden();
  await expect(page.getByRole("button", { name: "Workspace" })).toHaveText(/Current checkout/);
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await expect(page.getByRole("button", { name: "Workspace" })).toHaveText(/Previous worktree/);
  await shot(page, info, "workspace-previous-worktree-shortcut");
  await card.click();

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

test("D902–D903: a draft on GitHub finds a pull request from the branch search and checks it out", async ({
  page,
}, info) => {
  const node = await startNode({
    mode: "ui",
    setup: (home) => {
      // A stand-in for the GitHub CLI that knows pull request 7.
      const fake = Path.join(home, "fake-gh");
      Fs.mkdirSync(fake, { recursive: true });
      Fs.writeFileSync(
        Path.join(fake, "view-7.json"),
        JSON.stringify({
          number: 7,
          title: "Greet in French",
          url: "https://github.com/acme/app/pull/7",
          state: "OPEN",
          isDraft: false,
          headRefName: "feature/french",
          baseRefName: "main",
          statusCheckRollup: [],
          isCrossRepository: false,
          headRepositoryOwner: { login: "acme" },
          headRepository: { name: "app" },
        }),
      );
      Fs.writeFileSync(
        Path.join(fake, "gh"),
        `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  for arg in "$@"; do last="$arg"; done
  file="${fake}/view-$(basename "$last").json"
  if [ -f "$file" ]; then cat "$file"; exit 0; fi
  echo "no pull requests found" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[]'; exit 0; fi
exit 1
`,
        { mode: 0o755 },
      );
      const file = Path.join(home, ".jhin", "config.jsonc");
      const config = JSON.parse(Fs.readFileSync(file, "utf8"));
      Fs.writeFileSync(
        file,
        JSON.stringify(
          { ...config, "jhin.source-control": { ghPath: Path.join(fake, "gh") } },
          null,
          2,
        ),
      );
    },
  });
  running.push(node);
  const dir = Path.join(node.home, "acme");
  Fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  Fs.writeFileSync(Path.join(dir, "README.md"), "acme\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "first");
  git(dir, "remote", "add", "origin", "https://github.com/acme/app.git");
  await node.client().call("projects.create", { path: dir });

  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("option", { name: "New thread in...", exact: true }).click();
  await palette.getByRole("option", { name: /^acme/ }).click();
  await expect(palette).toBeHidden();

  // T3's branch picker offers the pull request the search names.
  await page.getByRole("combobox", { name: "Branch main" }).click();
  await page.getByRole("combobox", { name: "Search refs" }).fill("#7");
  const item = page.getByRole("option", { name: /Checkout pull request/ });
  await expect(item).toBeVisible();
  await shot(page, info, "checkout-pull-request-item");
  await item.click();

  // The dialog resolves it through the node.
  const dialog = page.getByRole("dialog", { name: "Checkout pull request" });
  await expect(dialog.getByText("Greet in French")).toBeVisible();
  await expect(dialog.getByText("#7 · feature/french to main")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Worktree" })).toBeEnabled();
  await shot(page, info, "checkout-pull-request-dialog");

  // A reference that is not one says so.
  await dialog.getByRole("textbox").fill("not a pr");
  await expect(
    dialog.getByText("Use a pull request URL, checkout command, 123, or #123."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("D1121–D1125: a new worktree runs the project's setup script and shows its progress", async ({
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
  const project = await node.client().call<{ id: string }>("projects.create", { path: dir });
  // The script waits for an answer typed into its terminal, then fails.
  await node.client().call("projects.update", {
    projectId: project.id,
    scripts: [
      {
        id: "install",
        name: "Install dependencies",
        command: 'echo "Installing dependencies"\nread answer\necho "got $answer"\nexit 2',
        runOnWorktreeCreate: true,
      },
    ],
  });

  await page.goto(`${node.ui}#token=${node.token}`);
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("option", { name: "New thread in...", exact: true }).click();
  await palette.getByRole("option", { name: /^acme/ }).click();
  await expect(palette).toBeHidden();
  const workspace = page.getByRole("button", { name: "Workspace" });
  await workspace.click();
  await page.getByRole("menuitemradio", { name: "New worktree" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("set up and say hello");
  await message.press("Enter");

  // T3's card under the first message: the script still runs beside the agent (async).
  const card = page.getByRole("region", { name: "Worktree setup" });
  await expect(card.getByText("Setting up worktree…")).toBeVisible();
  await expect(card.locator('[data-worktree-setup-stage="checkout"]')).toHaveAttribute(
    "data-worktree-setup-status",
    "done",
  );
  const script = card.locator('[data-worktree-setup-stage="setup-script"]');
  await expect(script).toContainText("Install dependencies");
  await expect(script).toHaveAttribute("data-worktree-setup-status", "running");
  await expect(card.getByLabel("Setup script output")).toContainText("Installing dependencies");
  await expect(card.locator('[data-worktree-setup-stage="agent"]')).toHaveAttribute(
    "data-worktree-setup-status",
    "done",
  );
  await card.getByRole("button", { name: "Details" }).click();
  await expect(card).toContainText("Base");
  await expect(card).toContainText("Setup");
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
  await shot(page, info, "worktree-setup-running");

  // "Open terminal" shows the script's terminal, where it waits for its answer.
  await card.getByRole("button", { name: "Open terminal" }).click();
  const drawer = page.getByRole("complementary", { name: "Terminal" });
  await expect(drawer.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await expect(drawer.locator(".xterm-rows")).toContainText("Installing dependencies");
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  await expect(drawer.locator(".xterm-rows")).toContainText("got yes");

  // The agent had started, so the finished setup folds into T3's summary row.
  const summary = card.locator('[data-worktree-setup-stage="summary"]');
  await expect(summary).toHaveText(/Worktree ready, setup script failed/);
  await expect(summary).toHaveAttribute("data-worktree-setup-status", "failed");
  await expect(card.getByRole("button", { name: "Cancel" })).toBeHidden();
  await shot(page, info, "worktree-setup-failed");
});
