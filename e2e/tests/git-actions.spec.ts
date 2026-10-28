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

/**
 * A stand-in for the GitHub CLI that remembers the pull requests it creates:
 * `gh pr create` writes one for its head, `gh pr list --head` prints it.
 */
function fakeGh(home: string): string {
  const dir = Path.join(home, "fake-gh");
  Fs.mkdirSync(dir, { recursive: true });
  const path = Path.join(dir, "gh");
  Fs.writeFileSync(
    path,
    `#!/bin/sh
safe() { echo "$1" | tr '/' '_'; }
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) base="$2"; shift 2;;
      --head) head="$2"; shift 2;;
      --title) title="$2"; shift 2;;
      *) shift;;
    esac
  done
  printf '[{"number":42,"title":"%s","url":"https://github.com/acme/app/pull/42","state":"OPEN","isDraft":false,"headRefName":"%s","baseRefName":"%s","statusCheckRollup":[]}]' "$title" "$head" "$base" > "${dir}/pr-$(safe "$head").json"
  printf '{"number":42,"title":"%s","url":"https://github.com/acme/app/pull/42","state":"OPEN","isDraft":false,"headRefName":"%s","baseRefName":"%s","statusCheckRollup":[]}' "$title" "$head" "$base" > "${dir}/view-42.json"
  echo "https://github.com/acme/app/pull/42"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  file="${dir}/view-$(basename "$3").json"
  if [ -f "$file" ]; then cat "$file"; exit 0; fi
  echo "no pull requests found" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  file="${dir}/pr-$(safe "$4").json"
  if [ -f "$file" ]; then cat "$file"; else echo '[]'; fi
  exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo '{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":false}'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  // A pull request stacked on the branch's own, linked by hand below.
  Fs.writeFileSync(
    Path.join(dir, "view-43.json"),
    JSON.stringify({
      number: 43,
      title: "Greet in French",
      url: "https://github.com/acme/app/pull/43",
      state: "OPEN",
      isDraft: false,
      headRefName: "feature/french",
      baseRefName: "feature/greeting",
      statusCheckRollup: [],
    }),
  );
  return path;
}

/** A repository on `feature/greeting` with changes, its origin on GitHub, pushing to a bare repository. */
function repository(home: string): string {
  const dir = Path.join(home, "acme");
  const remote = Path.join(home, "acme-remote.git");
  Fs.mkdirSync(Path.join(dir, "src"), { recursive: true });
  git(home, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  Fs.writeFileSync(Path.join(dir, "src/greet.ts"), 'export const greet = () => "Hello";\n');
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "first");
  git(dir, "remote", "add", "origin", "https://github.com/acme/app.git");
  git(dir, "config", "remote.origin.pushurl", remote);
  git(dir, "push", "--quiet", remote, "main:main");
  git(dir, "fetch", "--quiet", remote, "+refs/heads/*:refs/remotes/origin/*");
  git(dir, "switch", "--quiet", "--create", "feature/greeting");
  Fs.writeFileSync(
    Path.join(dir, "src/greet.ts"),
    "export const greet = (name: string) => `Hello ${name}`;\n",
  );
  Fs.writeFileSync(Path.join(dir, "src/main.ts"), 'console.log(greet("you"));\n');
  return dir;
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("D260–D274, D1281–D1283, D1663: the chat header's git actions commit, push and open a pull request; linking another makes a stack, watched from the menu and listed in the pull requests panel", async ({
  page,
}, info) => {
  const node = await startNode({
    mode: "ui",
    setup: (home) => {
      const gh = fakeGh(home);
      const file = Path.join(home, ".jhin", "config.jsonc");
      const config = JSON.parse(Fs.readFileSync(file, "utf8"));
      Fs.writeFileSync(
        file,
        // The fake agent writes nothing usable: messages come from the plain writer, never a model.
        JSON.stringify(
          {
            ...config,
            "jhin.source-control": { ghPath: gh, writerAgent: "jhin.agent-fake" },
            "jhin.threads": { defaultAgent: "jhin.agent-fake" },
          },
          null,
          2,
        ),
      );
    },
  });
  running.push(node);
  const dir = repository(node.home);
  const project = await node.client().call<{ id: string }>("projects.create", { path: dir });
  await node.client().call("threads.create", { projectId: project.id });

  await page.goto(`${node.ui}#token=${node.token}`);
  const card = threadRow(page, "New thread");
  await card.click();
  const actions = page.getByRole("group", { name: "Git actions" });
  await expect(actions.getByRole("button", { name: "Commit, push & PR" })).toBeVisible();

  // The menu, and the commit dialog with the files it would commit.
  await actions.getByRole("button", { name: "Git action options" }).click();
  await expect(page.getByRole("menuitem", { name: "Create PR" })).toBeVisible();
  await shot(page, info, "git-actions-menu");
  await page.getByRole("menuitem", { name: "Commit" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await expect(dialog.getByText("src/main.ts")).toBeVisible();
  await expect(dialog.getByText("src/greet.ts")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Commit message" }).fill("Greet by name");
  await shot(page, info, "git-actions-commit-dialog");
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByText(/^Committed [0-9a-f]{7}$/)).toBeVisible();
  expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("Greet by name");

  // Push & create the pull request: the toast offers to view it, the card shows it.
  await actions.getByRole("button", { name: "Push & create PR" }).click();
  await expect(page.getByText("Created PR #42")).toBeVisible();
  await expect(page.getByRole("button", { name: "View PR" })).toBeVisible();
  await expect(card.getByRole("link", { name: /^PR #42 - Open: Greet by name/ })).toBeVisible();
  await shot(page, info, "git-actions-created-pr");
  expect(git(dir, "rev-parse", "--abbrev-ref", "feature/greeting@{upstream}").trim()).toBe(
    "origin/feature/greeting",
  );

  // Linking the pull request stacked on it from the thread's menu: the card shows the stack.
  await page.getByRole("heading", { name: "New thread" }).getByRole("button").click();
  await page.getByRole("menuitem", { name: "Link pull request…" }).click();
  const prompt = page.getByRole("dialog", { name: "Link pull request" });
  await prompt.getByRole("textbox", { name: "Pull request" }).fill("#43");
  await prompt.getByRole("button", { name: "Link" }).click();
  const stack = card.getByRole("button", { name: "Stack of 2 pull requests, open" });
  await expect(stack).toHaveText("2");
  await stack.hover();
  await expect(page.getByText("stack · 2")).toBeVisible();
  await shot(page, info, "linked-pull-requests-stack");

  // Watching the bottom layer from the same menu marks it in the badge's list.
  await page.mouse.move(0, 0);
  await page.getByRole("heading", { name: "New thread" }).getByRole("button").click();
  await expect(page.getByRole("menuitem", { name: "Watch #43 for changes" })).toBeVisible();
  await shot(page, info, "watch-pull-request-menu");
  await page.getByRole("menuitem", { name: "Watch #42 for changes" }).click();
  await stack.hover();
  await expect(
    page.getByLabel(
      "Watching: the agent wakes when checks finish, someone comments, or the branch conflicts",
    ),
  ).toBeVisible();
  // The watch keeps the thread waiting between its turns, as T3's sidebar says (D1131).
  await expect(card).toContainText("Waiting");
  await page.mouse.move(700, 400);
  await expect(stack).toBeVisible();
  await shot(page, info, "watched-thread-waiting");

  // The stack's badge opens the thread's pull requests panel (D1281, D1282).
  await stack.click();
  const panel = page.getByRole("region", { name: "Pull requests" });
  const rows = panel.getByRole("list", { name: "Linked pull requests" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Greet by name");
  await expect(rows.nth(0).getByRole("img", { name: "Watching" })).toBeVisible();
  await expect(panel.getByText(/2 open · 2 linked · synced/)).toBeVisible();
  await rows.nth(1).hover();
  await panel.getByRole("button", { name: "Actions for #43" }).click();
  await expect(page.getByRole("menuitem", { name: "Unlink from thread" })).toBeVisible();
  // T3's pull request menu, read from the pull request's detail when it opens (D1663).
  await expect(page.getByRole("menuitem", { name: "Convert to draft" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Merge now" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Enable auto-merge" })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: "Merge commit" })).toBeChecked();
  await expect(page.getByRole("menuitem", { name: "Close pull request" })).toBeVisible();
  await shot(page, info, "pull-requests-panel");
  await page.getByRole("menuitem", { name: "Merge now" }).click();
  await expect(page.getByRole("menuitem", { name: "Confirm merge?" })).toBeVisible();
  await shot(page, info, "pull-request-menu-confirm-merge");
  await page.keyboard.press("Escape");

  // The thread details panel shows the current one, the other behind "Show 1 more" (D1283),
  // and stops the watch.
  const details = await showThreadDetails(page);
  await expect(details.getByRole("button", { name: "Show 1 more" })).toBeVisible();
  await details.getByRole("button", { name: "Show 1 more" }).click();
  await expect(details.getByRole("button", { name: "Stop watching #42" })).toBeVisible();
  await shot(page, info, "thread-details-pull-requests");
  await details.getByRole("button", { name: "Stop watching #42" }).click();
  await expect(card).not.toContainText("Waiting");
  await page.keyboard.press("Escape");
  // The surface's tab closes it, as T3's strip does (t3-parity.md D1422).
  await page
    .getByRole("complementary", { name: "Right panel" })
    .getByRole("button", { name: "Close Pull requests" })
    .click();
  await expect(panel).toBeHidden();
});
