// The rest of T3's pull request panel and details rows (docs/plans/source-control.md
// D1452–D1457): a row's author, diff stat and review decision, its checks popover, the speed
// actions under Shift, a row dragged into the composer, and the details row's Merge.
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startNode, type RunningNode } from "./support/node.ts";
import { showThreadDetails, threadRow } from "./support/ui.ts";

const running: RunningNode[] = [];
test.afterEach(async () => {
  for (const node of running.splice(0)) await node.stop();
});

const git = (cwd: string, ...args: string[]) =>
  ChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

const pullRequest = (number: number, fields: Record<string, unknown>) => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  headRefOid: `abc${number}`,
  updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  ...fields,
});

/** A stand-in for the GitHub CLI: two pull requests, their checks, the repository, actions. */
function fakeGh(home: string): string {
  const dir = Path.join(home, "fake-gh");
  Fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown) =>
    Fs.writeFileSync(Path.join(dir, name), JSON.stringify(value));
  write(
    "view-42.json",
    pullRequest(42, {
      title: "Greet by name",
      // The newest: the details panel's current pull request.
      updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      headRefName: "feature/greeting",
      baseRefName: "main",
      author: { login: "octo", name: "Octo Cat" },
      additions: 128,
      deletions: 14,
      changedFiles: 4,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    }),
  );
  write(
    "view-43.json",
    pullRequest(43, {
      title: "Greet in French",
      headRefName: "feature/french",
      baseRefName: "main",
      author: { login: "hubot", name: "Hubot" },
      additions: 9,
      deletions: 2,
      changedFiles: 1,
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://ci.example/run/7",
        },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    }),
  );
  write("repo.json", {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: false,
  });
  const path = Path.join(dir, "gh");
  Fs.writeFileSync(
    path,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  for arg in "$@"; do last="$arg"; done
  number="$(basename "$3")"
  if [ "$3" = "--json" ]; then number="$(basename "$last")"; fi
  file="${dir}/view-$number.json"
  if [ -f "$file" ]; then cat "$file"; exit 0; fi
  echo "no pull requests found" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then echo "no required checks reported" >&2; exit 1; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[]'; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then cat "${dir}/repo.json"; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then echo '{"data":{}}'; exit 0; fi
if [ "$1" = "api" ]; then echo '{"login":"jhin-bot"}'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then exit 0; fi
exit 1
`,
    { mode: 0o755 },
  );
  return path;
}

test("D1452–D1457: the panel's rows with their details, checks and speed actions; a row into the composer; Merge from the details row", async ({
  page,
}, info) => {
  let gh = "";
  const node = await startNode({
    mode: "ui",
    setup: (home) => {
      gh = fakeGh(home);
      const file = Path.join(home, ".jhin", "config.jsonc");
      const config = JSON.parse(Fs.readFileSync(file, "utf8"));
      Fs.writeFileSync(
        file,
        JSON.stringify({ ...config, "jhin.source-control": { ghPath: gh } }, null, 2),
      );
    },
  });
  running.push(node);
  const dir = Path.join(node.home, "acme");
  Fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  Fs.writeFileSync(Path.join(dir, "README.md"), "acme\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "first");
  git(dir, "remote", "add", "origin", "https://github.com/acme/app.git");
  const client = node.client();
  const project = await client.call<{ id: string }>("projects.create", { path: dir });
  const thread = await client.call<{ id: string }>("threads.create", {
    projectId: project.id,
    title: "Greetings",
  });
  for (const number of [42, 43]) {
    await client.call("git.pr.link", {
      threadId: thread.id,
      url: `https://github.com/acme/app/pull/${number}`,
      source: "manual",
    });
  }

  await page.goto(`${node.ui}#token=${node.token}`);
  await threadRow(page, "Greetings").click();
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Command palette" })
    .getByRole("option", { name: "Show linked pull requests" })
    .click();
  const panel = page.getByRole("region", { name: "Pull requests" });
  const list = panel.getByRole("list", { name: "Linked pull requests" });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(2);

  // T3's row details (D1452).
  const french = rows.filter({ hasText: "Greet in French" });
  await expect(french.getByText("hubot")).toBeVisible();
  await expect(french.getByText("+9")).toBeVisible();
  await expect(french.getByText("Changes requested")).toBeAttached();
  await expect(rows.filter({ hasText: "Greet by name" }).getByText("+128")).toBeVisible();
  await shot(page, info, "pull-requests-panel-details");

  // The checks popover reads them when it opens (D1457).
  await french.getByRole("button", { name: "Checks: Some checks were not successful" }).click();
  await expect(page.getByRole("list", { name: "Checks" }).getByText("test")).toBeVisible();
  await expect(page.getByText("Failed")).toBeVisible();
  await shot(page, info, "pull-requests-panel-checks");
  await page.keyboard.press("Escape");

  // Shift alone shows the quick actions (D1453).
  await page.mouse.move(0, 0);
  await page.keyboard.down("Shift");
  await expect(panel.getByRole("button", { name: "Merge #42" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Close #43" })).toBeVisible();
  await shot(page, info, "pull-requests-panel-speed-actions");
  await page.keyboard.up("Shift");
  await expect(panel.getByRole("button", { name: "Merge #42" })).toBeHidden();

  // A row dragged into the composer is its pull request's chip (D1454).
  const composer = page.getByRole("form", { name: "Composer" });
  await french.getByRole("link").dragTo(composer);
  await expect(composer.getByRole("button", { name: /#43/ })).toBeVisible();
  // The chip alone: the row's own text is not dropped into the message.
  await expect(composer).not.toContainText("hubot");
  await shot(page, info, "pull-request-dragged-into-composer");

  // The details row of the current pull request offers T3's Merge behind its dialog (D1456).
  const details = await showThreadDetails(page);
  const merge = details.getByRole("button", { name: "Merge", exact: true });
  await expect(merge).toBeVisible();
  await expect(details.getByRole("button", { name: /^Open checks: / })).toBeVisible();
  await shot(page, info, "thread-details-merge");
  await merge.click();
  const dialog = page.getByRole("alertdialog", { name: "Merge pull request?" });
  await expect(dialog.getByText("This merges #42 using merge.")).toBeVisible();
  await shot(page, info, "thread-details-merge-dialog");
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.getByText("Merge requested")).toBeVisible();
  const calls = Fs.readFileSync(Path.join(Path.dirname(gh), "calls"), "utf8");
  expect(calls).toContain("pr merge https://github.com/acme/app/pull/42 --merge");
});
