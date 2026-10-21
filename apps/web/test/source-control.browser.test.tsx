import type {
  Connections,
  Navigation,
  NodeCatalog,
  Route,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import { toDisposable, type PluginContext } from "@jhin/sdk";
import type { Diff, ProjectStatus, PullRequest, ThreadPullRequest } from "@jhin/source-control-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { createDiffPanel } from "../src/plugins/source-control/diff-panel.tsx";
import {
  createGitActionsControl,
  createRunningActions,
} from "../src/plugins/source-control/git-actions.tsx";
import { createCardIndicators } from "../src/plugins/source-control/indicators.tsx";
import type { SourceControlServices } from "../src/plugins/source-control/services.ts";
import type { SourceControlStore, SourceControlView } from "../src/plugins/source-control/store.ts";

const target = { node: "ws://a/rpc" };
const thread: ThreadRecord = {
  id: "t1",
  projectId: "app",
  title: "Port the toolbar",
  createdAt: "2026-10-19T10:00:00.000Z",
};
const pr: PullRequest = {
  number: 42,
  title: "Port the toolbar",
  url: "https://github.com/acme/app/pull/42",
  state: "merged",
  isDraft: false,
  headBranch: "feature/toolbar",
  baseBranch: "main",
  checks: { state: "passing", passed: 3, failed: 0, pending: 0, total: 3 },
};
const status = (fields: Partial<ProjectStatus> = {}): ProjectStatus => ({
  projectId: "app",
  isRepo: true,
  root: "/src/app",
  branch: "feature/toolbar",
  upstream: null,
  ahead: 0,
  behind: 0,
  defaultBranch: "main",
  remoteUrl: null,
  workingTree: { files: [], fileCount: 2, insertions: 1234, deletions: 5, truncated: false },
  provider: { kind: "github", available: true },
  pullRequests: { "feature/toolbar": pr },
  checkedAt: "2026-10-19T10:00:00.000Z",
  ...fields,
});

function services(view: SourceControlView, answers: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const shown: { type?: string; title: unknown; description?: unknown; action?: string }[] = [];
  const store: SourceControlStore = {
    view: () => view,
    subscribe: () => toDisposable(() => undefined),
    refresh: async () => undefined,
  };
  const catalog: NodeCatalog = { status: "ready", projects: [], threads: [thread] };
  const threads: ThreadsCatalog = {
    catalog: () => catalog,
    subscribe: () => toDisposable(() => undefined),
    call: async <T,>(_target: unknown, method: string, params?: unknown) => {
      calls.push({ method, params });
      return answers[method] as T;
    },
    open: async () => "",
  };
  let route: Route = { node: target.node, thread: "t1", panel: "diff" };
  const navigation: Navigation = {
    current: () => route,
    navigate: (next) => {
      route = next;
    },
    subscribe: () => toDisposable(() => undefined),
  };
  // No live connection: progress is not followed, the action still runs.
  const connections = {
    get: () => undefined,
    list: () => [],
    subscribe: () => toDisposable(() => undefined),
  } as unknown as Connections;
  const value: SourceControlServices = {
    context: {} as PluginContext,
    store,
    threads,
    connections,
    navigation,
    running: createRunningActions(),
    toasts: {
      show: (toast) => {
        shown.push({
          ...(toast.type === undefined ? {} : { type: toast.type }),
          title: toast.title,
          ...(toast.description === undefined ? {} : { description: toast.description }),
          ...(toast.action === undefined ? {} : { action: toast.action.label }),
        });
        return String(shown.length);
      },
      update: () => undefined,
      close: () => undefined,
    },
    shortcut: () => undefined,
  };
  return { value, calls, shown };
}

function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const viewWith = (project: ProjectStatus, branch: string | null = "feature/toolbar") => ({
  status: "ready" as const,
  projects: new Map([["app", project]]),
  threads: new Map([["t1", { threadId: "t1", projectId: "app", branch, at: "" }]]),
  links: new Map<string, readonly ThreadPullRequest[]>(),
});

describe("a thread card's source control indicators", () => {
  it("shows the branch, the pull request and the diff, in T3's order", () => {
    const { Branch, PullRequestIndicator, DiffCount } = createCardIndicators(
      services(viewWith(status())).value,
    );
    let clicks = 0;
    const props = { target, thread, active: false };
    const card = mount(
      <div onClick={() => clicks++}>
        <Branch {...props} />
        <PullRequestIndicator {...props} />
        <DiffCount {...props} />
      </div>,
    );
    const row = card.container.firstElementChild!;
    expect(row.children[0]!.getAttribute("aria-label")).toBe("Branch feature/toolbar");
    expect(row.children[0]!.textContent).toBe("feature/toolbar");
    const link = row.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(pr.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("aria-label")).toBe(
      "PR #42 - Merged: Port the toolbar. All checks have passed",
    );
    expect(link.textContent).toBe("42");
    expect(link.querySelector("span")!.className).toContain("text-violet-600");
    const diff = row.querySelector("[data-thread-diff]")!;
    expect(diff.textContent).toBe("+1,234 −5");
    expect(diff.getAttribute("aria-label")).toBe("1234 additions, 5 deletions");
    // Opening the pull request does not open the thread.
    link.addEventListener("click", (event) => event.preventDefault());
    act(() => link.click());
    expect(clicks).toBe(0);
    card.unmount();
  });

  it("shows no diff for a thread whose branch is not checked out, and nothing without a branch", () => {
    const elsewhere = createCardIndicators(services(viewWith(status({ branch: "main" }))).value);
    const props = { target, thread, active: false };
    const card = mount(
      <div>
        <elsewhere.Branch {...props} />
        <elsewhere.DiffCount {...props} />
      </div>,
    );
    expect(card.container.textContent).toBe("feature/toolbar");
    card.unmount();

    const none = createCardIndicators(services(viewWith(status(), null)).value);
    const empty = mount(
      <div>
        <none.Branch {...props} />
        <none.PullRequestIndicator {...props} />
        <none.DiffCount {...props} />
      </div>,
    );
    expect(empty.container.firstElementChild!.childElementCount).toBe(0);
    empty.unmount();
  });
});

describe("a thread's hover card lines (D443)", () => {
  const props = { target, thread, active: false };
  it("names the thread's branch and warns when the project has another one checked out", () => {
    const elsewhere = createCardIndicators(services(viewWith(status({ branch: "main" }))).value);
    const card = mount(
      <div>
        <elsewhere.BranchDetail {...props} />
        <elsewhere.BranchMismatch {...props} />
      </div>,
    );
    expect(card.container.querySelector("[data-thread-branch-detail]")!.textContent).toBe(
      "feature/toolbar",
    );
    expect(card.container.querySelector("[data-thread-branch-mismatch]")!.textContent).toBe(
      "You're currently checked out on another branch.",
    );
    card.unmount();
  });

  it("does not warn while the thread's branch is checked out, nor without a branch or a repository", () => {
    for (const view of [
      viewWith(status()),
      viewWith(status({ branch: "main" }), null),
      viewWith(status({ isRepo: false, branch: null })),
      viewWith(status({ branch: null })),
    ]) {
      const { BranchMismatch } = createCardIndicators(services(view).value);
      const card = mount(<BranchMismatch {...props} />);
      expect(card.container.childElementCount).toBe(0);
      card.unmount();
    }
  });
});

describe("the diff panel", () => {
  const diff: Diff = {
    projectId: "app",
    scope: "uncommitted",
    baseRef: null,
    headRef: null,
    patch: [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "",
    ].join("\n"),
    truncated: false,
    files: [{ path: "README.md", status: "modified", insertions: 1, deletions: 1, binary: false }],
    insertions: 1,
    deletions: 1,
  };

  it("shows the thread's project diff, file by file, and folds a file", async () => {
    const { value, calls } = services(viewWith(status()), { "git.diff": diff });
    const Panel = createDiffPanel(value);
    const panel = mount(<Panel />);
    await act(async () => undefined);
    expect(calls).toEqual([
      {
        method: "git.diff",
        params: { projectId: "app", scope: "uncommitted", ignoreWhitespace: false },
      },
    ]);
    const aside = panel.container.querySelector("aside")!;
    expect(aside.getAttribute("aria-label")).toBe("Diff panel");
    const file = aside.querySelector('[data-diff-file="README.md"]')!;
    expect(
      [...file.querySelectorAll("[data-line]")].map((row) => row.getAttribute("data-line")),
    ).toEqual(["context", "delete", "add"]);
    expect(file.textContent).toContain("TWO");
    const toggle = file.querySelector("button")!;
    expect(toggle.getAttribute("aria-label")).toBe("Collapse README.md");
    act(() => toggle.click());
    expect(file.querySelectorAll("[data-line]")).toHaveLength(0);
    panel.unmount();
  });

  it("says so when the project is no repository or has no changes", async () => {
    const Plain = createDiffPanel(
      services(viewWith(status({ isRepo: false, branch: null }))).value,
    );
    const first = mount(<Plain />);
    expect(first.container.textContent).toContain(
      "Turn diffs are unavailable because this project is not a git repository.",
    );
    first.unmount();

    const Clean = createDiffPanel(
      services(viewWith(status()), { "git.diff": { ...diff, patch: "", files: [] } }).value,
    );
    const second = mount(<Clean />);
    await act(async () => undefined);
    expect(second.container.textContent).toContain("No net changes in this selection.");
    second.unmount();
  });
});

describe("the git actions in the chat header", () => {
  const project = {
    id: "app",
    name: "app",
    path: "/src/app",
    scratch: false,
    createdAt: "2026-10-19T10:00:00.000Z",
  };
  const changed = {
    files: [
      { path: "src/a.ts", status: "modified" as const, insertions: 3, deletions: 1, binary: false },
      { path: "src/b.ts", status: "added" as const, insertions: 5, deletions: 0, binary: false },
    ],
    fileCount: 2,
    insertions: 8,
    deletions: 1,
    truncated: false,
  };
  const result = {
    actionId: "a1",
    action: "commit_push_pr",
    branch: { status: "skipped_not_requested" },
    commit: { status: "created", sha: "abcdef1234", subject: "Port the toolbar" },
    push: { status: "pushed", branch: "feature/toolbar", upstream: "origin/feature/toolbar" },
    pr: { status: "created", pullRequest: { ...pr, state: "open" } },
    toast: {
      title: "Created PR #42",
      description: "Port the toolbar",
      cta: { kind: "open_pr", label: "View PR", url: pr.url },
    },
  };
  const button = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll("button")].find(
      (element) =>
        element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
    );

  it("commits, pushes and opens a pull request from a feature branch, then shows the result", async () => {
    const { value, calls, shown } = services(
      viewWith(
        status({
          workingTree: changed,
          upstream: "origin/feature/toolbar",
          remoteUrl: "https://github.com/acme/app.git",
          pullRequests: {},
        }),
      ),
      { "git.action.run": result },
    );
    const Control = createGitActionsControl(value);
    const view = mount(<Control project={project} target={target} thread={thread} />);
    expect(view.container.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe(
      "Git actions",
    );
    const quick = button(view.container, "Commit, push & PR")!;
    await act(async () => quick.click());
    expect(calls).toContainEqual({
      method: "git.action.run",
      params: expect.objectContaining({
        projectId: "app",
        action: "commit_push_pr",
        threadId: "t1",
      }),
    });
    expect(shown).toEqual([
      {
        type: "success",
        title: "Created PR #42",
        description: "Port the toolbar",
        action: "View PR",
      },
    ]);
    view.unmount();
  });

  it("asks before pushing to the default branch, and can go to a feature branch instead", async () => {
    const { value, calls } = services(
      viewWith(
        status({
          branch: "main",
          workingTree: changed,
          upstream: "origin/main",
          remoteUrl: "https://github.com/acme/app.git",
          pullRequests: {},
        }),
        "main",
      ),
      { "git.action.run": result },
    );
    const Control = createGitActionsControl(value);
    const view = mount(<Control project={project} target={target} thread={thread} />);
    await act(async () => button(view.container, "Commit & push")!.click());
    expect(calls.filter((call) => call.method === "git.action.run")).toHaveLength(0);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Commit & push to default ref?");
    expect(dialog.textContent).toContain(
      'This action will commit and push changes on "main". You can continue on this ref or create a feature ref and run the same action there.',
    );
    await act(async () =>
      button(dialog as HTMLElement, "Check out feature branch & continue")!.click(),
    );
    expect(calls).toContainEqual({
      method: "git.action.run",
      params: expect.objectContaining({ action: "commit_push", featureBranch: true }),
    });
    view.unmount();
  });

  it("says why an action is unavailable, and offers to initialize a folder that is no repository", async () => {
    const { value, calls } = services(
      viewWith(
        status({
          upstream: "origin/feature/toolbar",
          remoteUrl: "x",
          pullRequests: {},
          aheadOfDefault: 0,
          workingTree: { files: [], fileCount: 0, insertions: 0, deletions: 0, truncated: false },
        }),
      ),
    );
    const Control = createGitActionsControl(value);
    const clean = mount(<Control project={project} target={target} thread={thread} />);
    // Clean and up to date: the quick action only explains itself.
    const quick = button(clean.container, "Commit")!;
    expect(quick.getAttribute("aria-disabled")).toBe("true");
    clean.unmount();

    const plain = services(
      viewWith(status({ isRepo: false, reason: "Not a git repository", branch: null })),
      { "git.init": status() },
    );
    const Init = createGitActionsControl(plain.value);
    const view = mount(<Init project={project} target={target} thread={thread} />);
    await act(async () => button(view.container, "Initialize Git")!.click());
    expect(plain.calls).toContainEqual({ method: "git.init", params: { projectId: "app" } });
    expect(calls).toEqual([]);
    view.unmount();
  });
});
