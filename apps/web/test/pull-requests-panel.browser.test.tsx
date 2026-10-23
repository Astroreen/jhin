// A thread's pull requests panel and the thread details rows (docs/plans/source-control.md,
// D1281, D1283): rows by chain, their glyphs and tooltips, the footer, the empty state, the
// row menu, the current one first and the others behind "Show N more".
import type { PullRequest, ThreadPullRequest } from "@jhin/source-control-api";
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
