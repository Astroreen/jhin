// A thread's pull requests panel and the thread details rows (docs/plans/source-control.md,
// D1281, D1283, D1452–D1457): rows by chain, their glyphs and tooltips, the footer, the empty
// state, the row menu, a row's details, checks popover, speed actions and drag, the current
// one first and the others behind "Show N more", and the details row's actions.
import type { PullRequest, PullRequestDetail, ThreadPullRequest } from "@jhin/source-control-api";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { PullRequestRows } from "../src/plugins/source-control/pull-request-rows.tsx";
import { ThreadPullRequestsList } from "../src/plugins/source-control/pull-requests-panel.tsx";

const checks = { state: null, passed: 0, failed: 0, pending: 0, total: 0 } as const;

function snapshot(number: number, head: string, base: string, extra: Partial<PullRequest> = {}) {
  return {
    number,
    title: `Layer ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: "open",
    isDraft: false,
    headBranch: head,
    baseBranch: base,
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    checks,
    ...extra,
  } satisfies PullRequest;
}

function link(
  number: number,
  pr: PullRequest | null,
  extra: Partial<ThreadPullRequest> = {},
): ThreadPullRequest {
  return {
    key: `github.com/acme/app#${number}`,
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "agent",
    linkedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    snapshot: pr,
    ...(pr === null ? {} : { syncedAt: new Date(Date.now() - 2 * 60_000).toISOString() }),
    ...extra,
  };
}

const watch = {
  startedAt: new Date().toISOString(),
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: new Date().toISOString(),
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  failures: 0,
};

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function render(node: ReactNode) {
  const host = document.createElement("div");
  host.style.height = "600px";
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
}

describe("the pull requests panel (D1281)", () => {
  it("lists the links by chain with their glyphs, tooltips and footer", async () => {
    const calls: string[] = [];
    const links = [
      link(1, snapshot(1, "feature-a", "main", { checks: { ...checks, state: "failing" } }), {
        source: "created",
        watch,
      }),
      link(2, snapshot(2, "feature-b", "feature-a")),
      link(9, null, { source: "manual" }),
    ];
    await render(
      <ThreadPullRequestsList
        actions={{
          copy: (item) => calls.push(`copy #${item.number}`),
          open: (item) => calls.push(`open #${item.number}`),
          setWatching: (item, watching) => calls.push(`watch #${item.number} ${watching}`),
          unlink: (item) => calls.push(`unlink #${item.number}`),
        }}
        links={links}
        onLink={() => calls.push("link")}
      />,
    );
    const list = page.getByRole("list", { name: "Linked pull requests" });
    const rows = list.getByRole("listitem");
    expect(rows.elements()).toHaveLength(3);
    // The stack's layers together, the bottom first; the one above is indented.
    const order = rows.elements().map((row) => row.textContent ?? "");
    const at = (text: string) => order.findIndex((row) => row.includes(text));
    expect(at("Layer 2")).toBe(at("Layer 1") + 1);
    expect(rows.elements()[at("Layer 2")]!.style.paddingLeft).toBe("1.75rem");
    await expect
      .element(list.getByRole("img", { name: "Some checks were not successful" }))
      .toBeInTheDocument();
    await expect.element(list.getByRole("img", { name: "Watching" })).toBeInTheDocument();
    await expect
      .element(list.getByRole("img", { name: "Waiting for host state" }))
      .toBeInTheDocument();
    // An unread link shows its repository for a title, and its host.
    await expect.element(list.getByText("github.com/acme/app")).toBeInTheDocument();
    await expect.element(page.getByText(/3 open · 3 linked · synced 2m ago/)).toBeInTheDocument();

    await userEvent.hover(list.getByText("#1", { exact: true }));
    await expect.element(page.getByText(/Created from this thread · 1h ago/)).toBeVisible();
    await userEvent.hover(rows.nth(at("Layer 1")).getByText("2", { exact: true }));
    await expect.element(page.getByText("2 pull requests chained by base branch.")).toBeVisible();
    // Away from the tooltip, which would stand over the row's menu button.
    await userEvent.unhover(rows.nth(at("Layer 1")).getByText("2", { exact: true }));
    await expect
      .element(page.getByText("2 pull requests chained by base branch."))
      .not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Actions for #1" }));
    await expect.element(page.getByRole("menuitem", { name: "Stop watching" })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "Copy link" }));
    await userEvent.click(page.getByRole("button", { name: "Actions for #2" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Watch for changes" }));
    await userEvent.click(page.getByRole("button", { name: "Actions for #9" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Unlink from thread" }));
    await userEvent.click(page.getByRole("button", { name: "Link" }));
    expect(calls).toEqual(["copy #1", "watch #2 true", "unlink #9", "link"]);
  });

  it("offers no watch for a merged one and says when nothing is linked", async () => {
    await render(
      <ThreadPullRequestsList
        actions={{ copy() {}, open() {}, setWatching() {}, unlink() {} }}
        links={[link(3, snapshot(3, "done", "main", { state: "merged" }))]}
        onLink={undefined}
      />,
    );
    await expect.element(page.getByRole("img", { name: "Merged" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Actions for #3" }));
    await expect.element(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Watch for changes" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(/0 open · 1 linked/)).toBeInTheDocument();
    cleanup?.();
    const linked: string[] = [];
    await render(
      <ThreadPullRequestsList
        actions={{ copy() {}, open() {}, setWatching() {}, unlink() {} }}
        links={[]}
        onLink={() => linked.push("link")}
      />,
    );
    await expect.element(page.getByText("No linked pull requests")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Link pull request" }));
    expect(linked).toEqual(["link"]);
  });
});

describe("the thread details rows (D1283)", () => {
  it("shows the current pull request first and the others behind Show N more", async () => {
    const stopped: number[] = [];
    await render(
      <PullRequestRows
        branchPullRequest={null}
        links={[
          link(1, snapshot(1, "feature-a", "main", { state: "merged" })),
          link(2, snapshot(2, "feature-b", "feature-a"), { watch }),
        ]}
        onStopWatching={(item) => stopped.push(item.number)}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: /^#2: / }))
      .toHaveTextContent("#2: Layer 2");
    await expect.element(page.getByRole("button", { name: /^#1: / })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Stop watching #2" }));
    expect(stopped).toEqual([2]);
    await userEvent.click(page.getByRole("button", { name: "Show 1 more" }));
    await expect
      .element(page.getByRole("button", { name: /^#1: / }))
      .toHaveTextContent("#1: Layer 1");
    await userEvent.click(page.getByRole("button", { name: "Show less" }));
    await expect.element(page.getByRole("button", { name: /^#1: / })).not.toBeInTheDocument();
  });

  it("shows the branch's pull request when nothing is linked, with its tooltip", async () => {
    await render(
      <PullRequestRows
        branchPullRequest={snapshot(7, "fix", "main", {
          checks: { state: "passing", passed: 3, failed: 0, pending: 0, total: 3 },
        })}
        links={[]}
        onStopWatching={() => {}}
      />,
    );
    const row = page.getByRole("button", { name: /^#7: / });
    await expect.element(row).toHaveTextContent("#7: Layer 7");
    await userEvent.hover(row);
    await expect.element(page.getByText("main ← fix")).toBeVisible();
    await expect.element(page.getByText("All checks have passed (3/3)")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /Stop watching/ }))
      .not.toBeInTheDocument();
  });
});

describe("a row's details, checks and speed actions (D1452, D1453, D1457)", () => {
  it("shows the author, diff stat, review decision and a conflict, and the checks on demand", async () => {
    const loaded: number[] = [];
    await render(
      <ThreadPullRequestsList
        actions={{
          copy() {},
          open() {},
          setWatching() {},
          unlink() {},
          checks: async (item) => {
            loaded.push(item.number);
            return [
              { name: "test", status: "failure", description: null, url: "https://ci/1" },
              { name: "lint", status: "success", description: null, url: null },
            ];
          },
          openUrl() {},
        }}
        links={[
          link(
            1,
            snapshot(1, "feature-a", "main", {
              checks: { state: "failing", passed: 1, failed: 1, pending: 0, total: 2 },
              author: { login: "octo", name: "Octo Cat", avatarUrl: null },
              additions: 1200,
              deletions: 3,
              reviewDecision: "changes-requested",
              mergeability: "conflicting",
            }),
          ),
        ]}
        onLink={undefined}
      />,
    );
    const list = page.getByRole("list", { name: "Linked pull requests" });
    await expect.element(list.getByText("octo")).toBeVisible();
    await expect.element(list.getByText("+1,200")).toBeVisible();
    await expect.element(list.getByText("-3")).toBeVisible();
    await expect.element(list.getByText("Changes requested")).toBeInTheDocument();
    await expect
      .element(list.getByRole("img", { name: "Conflicts with main" }))
      .toBeInTheDocument();
    // The checks are read when their popover opens, not before.
    expect(loaded).toEqual([]);
    await userEvent.click(
      list.getByRole("button", { name: "Checks: Some checks were not successful" }),
    );
    // As T3's lazy body: the checks without a summary line.
    await expect.element(page.getByText("Failed")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Details" })).toBeVisible();
    // The completed one waits behind "Show all".
    await expect.element(page.getByText("lint")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Show all" }));
    await expect.element(page.getByText("lint")).toBeVisible();
    expect(loaded).toEqual([1]);
    // Closed, so the next test's page is not held behind it.
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("lint")).not.toBeInTheDocument();
  });

  it("shows the quick actions while Shift alone is held, those the forge has", async () => {
    const acted: string[] = [];
    await render(
      <ThreadPullRequestsList
        actions={{
          copy() {},
          open() {},
          setWatching() {},
          unlink() {},
          act: async (item, action) => {
            acted.push(`${action} #${item.number}`);
          },
        }}
        links={[
          link(1, snapshot(1, "feature-a", "main")),
          link(2, snapshot(2, "feature-b", "main", { isDraft: true })),
          link(3, snapshot(3, "old", "main", { state: "closed" })),
          {
            ...link(8, snapshot(8, "bb", "main")),
            url: "https://bitbucket.org/acme/app/pull-requests/8",
            key: "bitbucket.org/acme/app#8",
          },
        ]}
        onLink={undefined}
      />,
    );
    const quick = page.getByRole("group", { name: "Quick actions for pull request #1" });
    // Hidden, and so out of the accessibility tree, until Shift is held.
    await expect.element(quick).not.toBeInTheDocument();
    await userEvent.keyboard("{Shift>}");
    await expect.element(quick).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close #1" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Ready for review #2" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reopen #3" })).toBeVisible();
    // Bitbucket has no reopen or ready; its open one merges and closes.
    await expect.element(page.getByRole("button", { name: "Merge #8" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Merge #1" }));
    await userEvent.keyboard("{/Shift}");
    await expect.element(quick).not.toBeInTheDocument();
    expect(acted).toEqual(["merge #1"]);
  });

  it("carries a row's pull request for the composer when dragged (D1454)", async () => {
    await render(
      <ThreadPullRequestsList
        actions={{ copy() {}, open() {}, setWatching() {}, unlink() {} }}
        links={[link(4, snapshot(4, "feature-d", "main"))]}
        onLink={undefined}
      />,
    );
    const anchor = page.getByRole("link").element();
    const data = new DataTransfer();
    anchor.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    expect(JSON.parse(data.getData("application/x-jhin-pull-request"))).toEqual({
      number: 4,
      title: "Layer 4",
      url: "https://github.com/acme/app/pull/4",
      headBranch: "feature-d",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    });
  });
});

describe("the details row's actions (D1456)", () => {
  const detail = (pr: PullRequest, extra: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
    pullRequest: pr,
    checks: [],
    mergeMethods: ["squash", "rebase"],
    actions: ["merge", "ready", "close", "reopen"],
    ...extra,
  });
  const access = (answer: PullRequestDetail, log: string[]) => ({
    detail: async () => answer,
    act: async (_url: string, action: string, method?: string) => {
      log.push(method === undefined ? action : `${action} ${method}`);
    },
    handoff: async (_url: string, prompt: string) => {
      log.push(`handoff ${prompt.split("\n")[0]}`);
    },
  });

  it("offers Fix for failing checks, with their count, and hands them off", async () => {
    const log: string[] = [];
    const pr = snapshot(1, "feature-a", "main", {
      changedFiles: 3,
      additions: 10,
      deletions: 2,
    });
    await render(
      <PullRequestRows
        access={access(
          detail(pr, {
            checks: [
              { name: "test", status: "failure", description: "2 failed", url: null },
              { name: "lint", status: "success", description: null, url: null },
            ],
          }),
          log,
        )}
        branchPullRequest={null}
        links={[link(1, pr)]}
        onStopWatching={() => {}}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Open checks: 1 of 2 failing" }))
      .toHaveTextContent("1 failed");
    // With its detail read, T3's row is the title, its number on the line below.
    await userEvent.hover(page.getByRole("button", { name: "Layer 1" }));
    await expect.element(page.getByText(/^3 files\+10-2$/)).toBeVisible();
    // Away from the row, whose tooltip would stand over its second line.
    await userEvent.unhover(page.getByRole("button", { name: "Layer 1" }));
    await expect.element(page.getByText(/^3 files\+10-2$/)).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Fix" }));
    expect(log).toEqual([
      "handoff Fix the actionable findings on PR #1, titled `Layer 1`, at `https://github.com/acme/app/pull/1`.",
    ]);
  });

  it("drops a detail read while open once the snapshot says merged", async () => {
    const open = snapshot(5, "feature-e", "main");
    const answer = detail(open, {
      checks: [{ name: "test", status: "success", description: null, url: null }],
    });
    const rowAccess = access(answer, []);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (pr: PullRequest) =>
      act(async () =>
        root.render(
          <PullRequestRows
            access={rowAccess}
            branchPullRequest={null}
            links={[link(5, pr)]}
            onStopWatching={() => {}}
          />,
        ),
      );
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    await show(open);
    await expect.element(page.getByRole("button", { name: "Merge" })).toBeVisible();
    await show({ ...open, state: "merged" });
    await expect.element(page.getByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^#5: / })).toBeVisible();
  });

  it("offers Merge behind T3's dialog, Ready for a draft and Resolve for a conflict", async () => {
    const log: string[] = [];
    const ready = snapshot(1, "feature-a", "main");
    await render(
      <PullRequestRows
        access={access(
          detail(ready, {
            checks: [{ name: "test", status: "success", description: null, url: null }],
          }),
          log,
        )}
        branchPullRequest={null}
        links={[link(1, ready)]}
        onStopWatching={() => {}}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Merge" }));
    const dialog = page.getByRole("alertdialog", { name: "Merge pull request?" });
    await expect.element(dialog.getByText("This merges #1 using squash.")).toBeVisible();
    await act(async () =>
      (dialog.getByRole("button", { name: "Merge" }).element() as HTMLElement).click(),
    );
    expect(log).toEqual(["merge squash"]);
    cleanup?.();

    const draft = snapshot(2, "feature-b", "main", { isDraft: true });
    await render(
      <PullRequestRows
        access={access(detail(draft), log)}
        branchPullRequest={null}
        links={[link(2, draft)]}
        onStopWatching={() => {}}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Ready" }));
    expect(log).toEqual(["merge squash", "ready"]);
    cleanup?.();

    const conflicting = snapshot(3, "feature-c", "main", { mergeability: "conflicting" });
    await render(
      <PullRequestRows
        access={access(detail(conflicting), log)}
        branchPullRequest={null}
        links={[link(3, conflicting)]}
        onStopWatching={() => {}}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Resolve" }));
    expect(log.at(-1)).toBe(
      "handoff PR #3 (https://github.com/acme/app/pull/3) conflicts with its base branch `main`. Its branch `feature-c` is the checkout prepared for this thread.",
    );
  });
});
