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

/**
 * A stand-in for the GitHub CLI: an open pull request with passing checks for
 * `feature/toolbar`, none for any other branch. The node is told to use it
 * (`jhin.source-control.ghPath`), so nothing reaches GitHub.
 */
function fakeGh(home: string): string {
  const path = Path.join(home, "fake-gh");
  const pr = {
    number: 7,
    title: "Port the branch toolbar",
    url: "https://github.com/acme/app/pull/7",
    state: "OPEN",
    isDraft: false,
    headRefName: "feature/toolbar",
    baseRefName: "main",
    updatedAt: "2026-10-19T10:00:00Z",
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  };
  Fs.writeFileSync(
    path,
    `#!/bin/sh
if [ "$4" = "feature/toolbar" ]; then echo '${JSON.stringify([pr])}'; else echo '[]'; fi
`,
    { mode: 0o755 },
  );
  return path;
}

/** A repository on `feature/toolbar` with uncommitted changes, its origin on GitHub. */
function repository(home: string): string {
  const dir = Path.join(home, "acme");
  Fs.mkdirSync(Path.join(dir, "src"), { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  Fs.writeFileSync(Path.join(dir, "src/greet.ts"), 'export const greet = () => "Hello";\n');
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "first");
  git(dir, "remote", "add", "origin", "https://github.com/acme/app.git");
  git(dir, "switch", "--quiet", "--create", "feature/toolbar");
  Fs.writeFileSync(
    Path.join(dir, "src/greet.ts"),
    'export const greet = (name: string) => `Hello ${name}`;\nexport const bye = () => "Bye";\n',
  );
  Fs.writeFileSync(Path.join(dir, "src/main.ts"), 'console.log("hi");\n');
  return dir;
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D113–D120: a card shows its thread's branch, pull request and diff; the diff panel and the branch toolbar", async ({
  page,
}, info) => {
  let gh = "";
  const node = await startNode({
    mode: "ui",
    setup: (home) => {
      gh = fakeGh(home);
      // The node reads its config on start: the fake gh is in place by then.
      const file = Path.join(home, ".jhin", "config.jsonc");
      const config = JSON.parse(Fs.readFileSync(file, "utf8"));
      Fs.writeFileSync(
        file,
        JSON.stringify({ ...config, "jhin.source-control": { ghPath: gh } }, null, 2),
      );
    },
  });
  running.push(node);
  const dir = repository(node.home);
  const project = await node.client().call<{ id: string }>("projects.create", { path: dir });
  await node.client().call("threads.create", { projectId: project.id });

  await page.goto(`${node.ui}#token=${node.token}`);
  const card = threadRow(page, "New thread");
  await expect(card.getByRole("img", { name: "Branch feature/toolbar" })).toBeVisible();
  const pr = card.getByRole("link", {
    name: "PR #7 - Open: Port the branch toolbar. All checks have passed",
  });
  await expect(pr).toHaveText("7");
  await expect(pr).toHaveAttribute("href", "https://github.com/acme/app/pull/7");
  // greet.ts: 2 lines for 1; main.ts: 1 new line.
  await expect(card.getByRole("img", { name: "3 additions, 1 deletions" })).toHaveText("+3 −1");

  // The repository is watched: a file written on disk shows on the card.
  Fs.writeFileSync(Path.join(dir, "src/new.ts"), "a\nb\n");
  await expect(card.getByRole("img", { name: "5 additions, 1 deletions" })).toBeVisible();
  await shot(page, info, "source-control-card");

  await card.click();
  await page.getByRole("button", { name: "Toggle diff panel" }).click();
  const panel = page.getByRole("complementary", { name: "Diff panel" });
  await expect(panel.getByRole("button", { name: "Diff scope: Uncommitted" })).toBeVisible();
  await expect(panel.getByRole("group", { name: "5 additions, 1 deletions" })).toBeVisible();
  for (const file of ["src/greet.ts", "src/main.ts", "src/new.ts"]) {
    await expect(panel.getByRole("region", { name: file })).toBeVisible();
  }
  await expect(panel.getByRole("region", { name: "src/greet.ts" })).toContainText(
    "export const bye",
  );
  // The branch toolbar under the composer: the pull request and the branch.
  const toolbar = page.getByRole("combobox", { name: "Branch feature/toolbar" });
  await expect(toolbar).toBeVisible();
  await shot(page, info, "source-control-diff-panel");

  // The branch's changes against main, as T3's "Changes" scope shows them.
  await panel.getByRole("button", { name: "Diff scope: Uncommitted" }).click();
  await page.getByRole("menuitemradio", { name: "Changes" }).click();
  await expect(panel.getByLabel("Comparing feature/toolbar against main")).toBeVisible();

  // Switching the thread to main from the toolbar: the card follows, no pull request there.
  await toolbar.click();
  await page.getByRole("option", { name: /^main/ }).click();
  await expect(card.getByRole("img", { name: "Branch main" })).toBeVisible();
  await expect(card.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Branch main" })).toBeVisible();
  expect(git(dir, "branch", "--show-current").trim()).toBe("main");
  // The panel reads the diff again for the new checkout.
  await expect(panel.getByLabel("Comparing main against main")).toBeVisible();
  await shot(page, info, "source-control-switched");

  await page.getByRole("button", { name: "Toggle diff panel" }).click();
  await expect(panel).toBeHidden();

  // D443: checked out elsewhere (not by the thread), the hover card warns, as T3's does.
  git(dir, "switch", "--quiet", "feature/toolbar");
  await card.hover();
  const warning = page.getByText("You're currently checked out on another branch.");
  await expect(warning).toBeVisible();
  // The slot's lines come after the project's, as T3 orders them.
  const lines = page.locator("[data-thread-branch-detail]").locator("..");
  await expect(lines).toHaveText(/acme\s*main\s*You're currently checked out on another branch\.$/);
  await shot(page, info, "source-control-branch-mismatch");
  git(dir, "switch", "--quiet", "main");
  await page.mouse.move(600, 400);
  await card.hover();
  await expect(page.locator("[data-thread-branch-detail]")).toHaveText("main");
  await expect(warning).toBeHidden();
});
