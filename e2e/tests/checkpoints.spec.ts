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

test("D243–D249: a turn's checkpoint, its changed files card, the card's count and the turn scopes", async ({
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
  const client = node.client();
  const project = await client.call<{ id: string }>("projects.create", { path: dir });
  const thread = await client.call<{ id: string }>("threads.create", { projectId: project.id });

  await page.goto(`${node.ui}#token=${node.token}`);
  const card = threadRow(page, "New thread");
  await card.click();

  // The fake agent writes two files in the thread's directory.
  await client.call("threads.send", { threadId: thread.id, text: "/write src/app/greet.ts hello" });
  const changed = page.getByRole("region", { name: "Changed files" });
  await expect(changed).toContainText("1 changed file");
  await client.call("threads.send", { threadId: thread.id, text: "/write src/app/bye.ts bye" });
  await expect(changed.nth(1)).toContainText("1 changed file");
  await expect(changed.nth(1).getByRole("button", { name: /bye\.ts/ })).toBeVisible();
  // The card counts the latest turn (D249).
  await expect(
    threadRow(page, "/write src/app/greet.ts hello").getByRole("img", {
      name: "1 additions, 0 deletions",
    }),
  ).toHaveText("+1 −0");
  await shot(page, info, "checkpoints-changed-files");

  // "Open diff" opens the panel on that turn.
  await changed.nth(1).getByRole("button", { name: "Open diff" }).click();
  const panel = page.getByRole("complementary", { name: "Diff panel" });
  await expect(panel.getByRole("button", { name: "Diff scope: Latest turn" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "src/app/bye.ts" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "src/app/greet.ts" })).toHaveCount(0);

  // An earlier turn from the "Turn" submenu.
  await panel.getByRole("button", { name: "Diff scope: Latest turn" }).click();
  await page.getByRole("menuitem", { name: "Turn" }).click();
  await page.getByRole("menuitemradio", { name: /Turn 1/ }).click();
  await expect(panel.getByRole("button", { name: "Diff scope: Turn 1" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "src/app/greet.ts" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "src/app/bye.ts" })).toHaveCount(0);
  await shot(page, info, "checkpoints-turn-scope");

  // The user's own git is untouched: both files are untracked, nothing is staged.
  expect(git(dir, "status", "--porcelain")).toBe("?? src/\n");
  expect(git(dir, "for-each-ref", "--format=%(refname)", "refs/jhin/").trim().split("\n")).toEqual([
    `refs/jhin/checkpoints/${thread.id}/0`,
    `refs/jhin/checkpoints/${thread.id}/1`,
    `refs/jhin/checkpoints/${thread.id}/2`,
  ]);
});
