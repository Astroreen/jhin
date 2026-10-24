import type { MessageContextRecord, ReviewCommentContextRecord } from "@jhin/agent-api";
import type {
  ChatDrafts,
  Connections,
  Navigation,
  NodeCatalog,
  Route,
  ThreadDeleteInput,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import { toDisposable, type Disposable, type PluginContext } from "@jhin/sdk";
import type {
  Branch,
  Diff,
  DiffScopeProvider,
  ProjectStatus,
  PullRequest,
  ThreadPullRequest,
  TurnCheckpoint,
} from "@jhin/source-control-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { formatShortTimestamp } from "../src/lib/format.ts";
import { createChangedFilesFooter } from "../src/plugins/source-control/checkpoints.tsx";
import { createBranchToolbar } from "../src/plugins/source-control/branch-toolbar.tsx";
import { createDiffPanel } from "../src/plugins/source-control/diff-panel.tsx";
import { createGitActionsControl } from "../src/plugins/source-control/git-actions.tsx";
import { createRunningActions } from "../src/plugins/source-control/running.ts";
import { createCardIndicators } from "../src/plugins/source-control/indicators.tsx";
import {
  createDiffScopes,
  createDiffSelections,
  gitScopeProvider,
  selectionKey,
} from "../src/plugins/source-control/diff/scopes.ts";
import { turnScopeProvider } from "../src/plugins/source-control/diff/turns.ts";
import { createEditors } from "../src/plugins/source-control/diff/editors.tsx";
import type { SourceControlServices } from "../src/plugins/source-control/services.ts";
import { DIFF_SECTION, DiffSettings } from "../src/lib/settings.ts";
import type { SourceControlStore, SourceControlView } from "../src/plugins/source-control/store.ts";
import {
  createDraftWorkspaces,
  createWorktreeIndicator,
  draftKey,
  registerWorktreeCleanup,
} from "../src/plugins/source-control/workspace.tsx";

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

/** A plugin context whose config holds the `jhin.diff` section a device sets. */
function deviceConfig(
  values: Partial<DiffSettings> = {},
  /** Client commands the context runs, e.g. the chat's `chat.composer.insert`. */
  commands: Record<string, (input: unknown) => unknown> = {},
) {
  let current: Record<string, unknown> = { ...values };
  const listeners = new Set<() => void>();
  const eventListeners = new Map<string, Set<() => void>>();
  const context = {
    commands: {
      list: () => Object.keys(commands).map((name) => ({ name })),
      execute: async (name: string, input: unknown) => commands[name]!(input),
    },
    events: {
      on: (type: string, listener: () => void): Disposable => {
        const set = eventListeners.get(type) ?? new Set();
        eventListeners.set(type, set);
        set.add(listener);
        return toDisposable(() => set.delete(listener));
      },
      emit: (type: string) => {
        for (const listener of eventListeners.get(type) ?? []) listener();
      },
    },
    config: {
      get: (section: string) => {
        if (section !== DIFF_SECTION) throw new Error(`No section ${section}`);
        return DiffSettings.parse(current);
      },
      onDidChange: (_section: string, listener: () => void): Disposable => {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    },
  } as unknown as PluginContext;
  const patches: Record<string, unknown>[] = [];
  const settings = {
    values: () => current,
    patch: (_section: string, patch: Readonly<Record<string, unknown>>) => {
      patches.push({ ...patch });
      current = { ...current, ...patch };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    reset: () => undefined,
  };
  return { context, settings, patches };
}

function services(
  view: SourceControlView,
  answers: Record<string, unknown> = {},
  config = deviceConfig(),
  projectPath = "/src/app",
  drafts?: ChatDrafts,
) {
  const calls: { method: string; params: unknown }[] = [];
  const shown: { type?: string; title: unknown; description?: unknown; action?: string }[] = [];
  const store: SourceControlStore = {
    view: () => view,
    subscribe: () => toDisposable(() => undefined),
    refresh: async () => undefined,
  };
  const catalog: NodeCatalog = {
    status: "ready",
    projects: [
      { id: "app", name: "app", path: projectPath, scratch: false, createdAt: thread.createdAt },
    ],
    threads: [thread],
  };
  const threads: ThreadsCatalog = {
    catalog: () => catalog,
    subscribe: () => toDisposable(() => undefined),
    call: async <T,>(_target: unknown, method: string, params?: unknown) => {
      calls.push({ method, params });
      const answer = answers[method];
      return (typeof answer === "function" ? answer(params) : answer) as T;
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
  const scopes = createDiffScopes();
  scopes.register(gitScopeProvider(threads));
  const storage = new Map<string, string>();
  const value: SourceControlServices = {
    context: config.context,
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
    scopes,
    editors: createEditors(threads, undefined),
    selections: createDiffSelections({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, item: string) => storage.set(key, item),
    } as unknown as Storage),
    settings: config.settings,
    drafts,
    timestampFormat: () => "24-hour",
    shortcut: () => undefined,
  };
  scopes.register(turnScopeProvider(value));
  return { value, calls, shown, scopes, config };
}

/** The gutter's "+" buttons Pierre shows (in its shadow DOM) for the hovered line. */
function visiblePlusButtons(): HTMLElement[] {
  return [...document.querySelectorAll("diffs-container")]
    .flatMap((host) => [...(host.shadowRoot?.querySelectorAll("[data-utility-button]") ?? [])])
    .filter((button): button is HTMLElement => (button as HTMLElement).offsetParent !== null);
}

const mounts = new Set<() => void>();
beforeAll(async () => {
  // Wide enough for the panel and its file tree, as in a desktop window.
  await page.viewport(1280, 800);
});
afterEach(() => {
  for (const unmount of mounts) unmount();
});

function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  // The panel fills the height of the app's main row.
  container.style.height = "640px";
  container.style.display = "flex";
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  const unmount = () => {
    if (!mounts.delete(unmount)) return;
    act(() => root.unmount());
    container.remove();
  };
  mounts.add(unmount);
  return { container, unmount };
}

const viewWith = (
  project: ProjectStatus,
  branch: string | null = "feature/toolbar",
): SourceControlView => ({
  status: "ready" as const,
  projects: new Map([["app", project]]),
  threads: new Map([["t1", { threadId: "t1", projectId: "app", branch, at: "" }]]),
  links: new Map<string, readonly ThreadPullRequest[]>(),
  checkpoints: new Map(),
  worktrees: new Map(),
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

  it("opens the pull requests panel from a stack's badge, and a single link's page (D1282)", () => {
    const linked = (number: number, head: string, base: string): ThreadPullRequest => ({
      key: `github.com/acme/app#${number}`,
      host: "github.com",
      repository: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      source: "agent",
      linkedAt: "2026-10-19T10:00:00.000Z",
      snapshot: {
        ...pr,
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        state: "open",
        headBranch: head,
        baseBranch: base,
      },
    });
    const stacked = {
      ...viewWith(status()),
      links: new Map([["t1", [linked(1, "a", "main"), linked(2, "b", "a")]]]),
    };
    const { value } = services(stacked);
    value.navigation.navigate({ node: target.node, thread: "t2" });
    const { PullRequestIndicator } = createCardIndicators(value);
    let clicks = 0;
    const card = mount(
      <div onClick={() => clicks++}>
        <PullRequestIndicator active={false} target={target} thread={thread} />
      </div>,
    );
    const button = card.container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Stack of 2 pull requests, open");
    expect(card.container.querySelector("a")).toBeNull();
    act(() => button.click());
    expect(value.navigation.current()).toEqual({
      node: target.node,
      thread: "t1",
      panel: "pull-requests",
    });
    expect(clicks).toBe(0);
    card.unmount();

    const single = { ...viewWith(status()), links: new Map([["t1", [linked(3, "c", "main")]]]) };
    const one = createCardIndicators(services(single).value);
    const alone = mount(
      <one.PullRequestIndicator active={false} target={target} thread={thread} />,
    );
    expect(alone.container.querySelector("button")).toBeNull();
    expect(alone.container.querySelector("a")!.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/3",
    );
    alone.unmount();
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
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,2 @@",
    " const one = 1;",
    "-const two = 2;",
    "+const two = 3;",
    "diff --git a/docs/notes.md b/docs/notes.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/docs/notes.md",
    "@@ -0,0 +1 @@",
    "+# Notes",
    "",
  ].join("\n");
  const diff: Diff = {
    projectId: "app",
    scope: "branch",
    baseRef: "main",
    headRef: "feature/toolbar",
    patch,
    truncated: false,
    files: [
      { path: "docs/notes.md", status: "added", insertions: 1, deletions: 0, binary: false },
      { path: "src/app.ts", status: "modified", insertions: 1, deletions: 1, binary: false },
    ],
    insertions: 2,
    deletions: 1,
  };
  const panel = () => page.getByRole("complementary", { name: "Diff panel" });

  it("shows the branch's changes with Pierre, files folded, and highlights a file it unfolds", async () => {
    const { value, calls } = services(viewWith(status()), { "git.diff": diff });
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    await expect.element(page.getByRole("button", { name: "Expand src/app.ts" })).toBeVisible();
    // T3's default scope is "Changes", whitespace hidden.
    expect(calls.filter((call) => call.method === "git.diff")).toEqual([
      {
        method: "git.diff",
        params: { threadId: "t1", scope: "branch", ignoreWhitespace: true },
      },
    ]);
    expect(
      page.getByRole("combobox", { name: "Change comparison target. Currently main" }).element(),
    ).toBeTruthy();
    expect(panel().getByRole("button", { name: "Diff scope: Changes" }).element()).toBeTruthy();
    expect(page.getByText("const two = 3;").query()).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Expand src/app.ts" }));
    await expect.element(page.getByRole("button", { name: "Collapse src/app.ts" })).toBeVisible();
    const added = page.getByText("3", { exact: true });
    await expect.element(added).toBeVisible();
    // Highlighted by Shiki in a worker: tokens carry their theme colour.
    expect(
      (added.element() as HTMLElement).closest("[data-line-type]")?.getAttribute("data-line-type"),
    ).toBe("change-addition");
    expect(
      [
        ...((added.element() as HTMLElement)
          .closest("[data-line]")
          ?.querySelectorAll("span[style]") ?? []),
      ].length,
    ).toBeGreaterThan(1);
    mounted.unmount();
  });

  it("expands the unchanged lines above a hunk with the file's two sides (D921)", async () => {
    const later = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -3,2 +3,2 @@",
      " const one = 1;",
      "-const two = 2;",
      "+const two = 3;",
      "",
    ].join("\n");
    const head = "// app\nconst zero = 0;\nconst one = 1;\n";
    const { value, calls } = services(
      viewWith(status()),
      {
        "git.diff": { ...diff, patch: later },
        "git.diff.file": {
          oldContents: `${head}const two = 2;\n`,
          newContents: `${head}const two = 3;\n`,
        },
      },
      deviceConfig({ filesCollapsed: false }),
    );
    // A click may focus the test's window, and the panel reads the diff again on focus (T3
    // does) while the click lands; this test is about the click, so the panel never hears it.
    const quiet = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener("focus", quiet);
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    try {
      await userEvent.click(page.getByText("2 unmodified lines").first());
      await expect.element(page.getByText("const zero = 0;")).toBeVisible();
      expect(calls.filter((call) => call.method === "git.diff.file")).toEqual([
        {
          method: "git.diff.file",
          params: { threadId: "t1", scope: "branch", base: "main", path: "src/app.ts" },
        },
      ]);
    } finally {
      mounted.unmount();
      window.removeEventListener("focus", quiet);
    }
  });

  it("finds in the diff and unfolds the file of the match (D924)", async () => {
    const { value } = services(viewWith(status()), { "git.diff": diff });
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    await expect.element(page.getByRole("button", { name: "Expand src/app.ts" })).toBeVisible();
    // The view takes the keys once it has focus, as a click in it gives it.
    const view = panel().element().querySelector<HTMLElement>(".diff-render-surface")!;
    act(() => view.focus());
    await userEvent.keyboard("{ControlOrMeta>}f{/ControlOrMeta}");
    const search = page.getByPlaceholder("Search");
    await expect.element(search).toBeVisible();
    // "const" is on three lines of the folded src/app.ts; typing moves to the first,
    // and that unfolds its file.
    await userEvent.type(search, "const");
    await expect.element(page.getByRole("button", { name: "Collapse src/app.ts" })).toBeVisible();
    await expect.element(page.getByText("1 of 3")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("2 of 3")).toBeVisible();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect.element(page.getByText("1 of 3")).toBeVisible();
    await userEvent.keyboard("{ControlOrMeta>}g{/ControlOrMeta}");
    await expect.element(page.getByText("2 of 3")).toBeVisible();
    // Moving within the unfolded file never folds it.
    expect(page.getByRole("button", { name: "Collapse src/app.ts" }).query()).not.toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, "nowhere in the diff");
    await expect.element(page.getByText("No results")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(search).not.toBeInTheDocument();
    mounted.unmount();
  });

  it("switches to the split view and writes the layout on the device", async () => {
    const config = deviceConfig({ filesCollapsed: false });
    const { value } = services(viewWith(status()), { "git.diff": diff }, config);
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    await expect.element(page.getByText("const one = 1;")).toBeVisible();
    const pre = () =>
      (page.getByText("const one = 1;").first().element() as HTMLElement).closest("pre");
    expect(pre()?.getAttribute("data-diff-type")).toBe("single");
    await userEvent.click(page.getByRole("button", { name: "Split diff view" }));
    expect(config.patches).toEqual([{ layout: "split" }]);
    // Both sides show the unchanged line.
    await expect.element(page.getByText("const one = 1;").nth(1)).toBeVisible();
    expect(pre()?.getAttribute("data-diff-type")).toBe("split");
    mounted.unmount();
  });

  it("draws the tree's files with T3's icons (D923)", async () => {
    const added = (path: string) =>
      [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${path}`,
        "@@ -0,0 +1 @@",
        "+x",
      ].join("\n");
    const { value } = services(viewWith(status()), {
      "git.diff": { ...diff, patch: `${added("AGENTS.md")}\n${added("src/Main.kt")}\n` },
    });
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    await userEvent.click(page.getByRole("button", { name: "Show file tree" }));
    const tree = page.getByRole("tree");
    await expect.element(tree.getByRole("treeitem", { name: "Main.kt" })).toBeVisible();
    const iconOf = (name: string) =>
      [...tree.getByRole("treeitem", { name }).element().querySelectorAll("use")].map((use) =>
        use.getAttribute("href"),
      );
    // Icons Pierre's own set does not have: T3's additions.
    expect(iconOf("AGENTS.md")).toContain("#t3-file-icon-agents");
    expect(iconOf("Main.kt")).toContain("#t3-file-icon-kotlin");
    // The tree's state is kept on the device: leave it closed for the tests after this one.
    await userEvent.click(page.getByRole("button", { name: "Hide file tree" }));
    mounted.unmount();
  });

  it("lists the files in a tree and reveals the one chosen", async () => {
    const { value } = services(viewWith(status()), { "git.diff": diff });
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    await userEvent.click(page.getByRole("button", { name: "Show file tree" }));
    const tree = page.getByRole("tree");
    await expect.element(tree.getByRole("treeitem", { name: "app.ts" })).toBeVisible();
    expect(
      tree
        .getByRole("treeitem")
        .elements()
        .map((item) => item.getAttribute("aria-label") ?? item.textContent?.trim()),
    ).toEqual(["src", "app.ts", "docs", "notes.md"]);
    // Without the app's stylesheet the tree has no height to hit-test in, so click it directly.
    act(() => (tree.getByRole("treeitem", { name: "app.ts" }).element() as HTMLElement).click());
    await expect.element(page.getByRole("button", { name: "Collapse src/app.ts" })).toBeVisible();
    expect(page.getByRole("button", { name: "Expand docs/notes.md" }).element()).toBeTruthy();
    mounted.unmount();
  });

  it("says why the base ref picker has no refs when git.branches fails, and reads them again", async () => {
    let reads = 0;
    const { value } = services(viewWith(status()), {
      "git.diff": diff,
      "git.branches": () => {
        reads++;
        if (reads === 1) throw new Error("git is busy");
        return {
          branches: [
            { name: "develop", current: false, isDefault: false, isRemote: false, upstream: null },
          ],
        };
      },
    });
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    await userEvent.click(
      page.getByRole("combobox", { name: "Change comparison target. Currently main" }),
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not read refs: git is busy");
    // The reason replaces "No matching refs.", not joins it.
    expect(page.getByText("No matching refs.").query()).toBeNull();
    // Opened again, the picker reads the refs again, and the reason goes.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      page.getByRole("combobox", { name: "Change comparison target. Currently main" }),
    );
    await expect.element(page.getByRole("option", { name: "develop" })).toBeVisible();
    expect(page.getByRole("alert").query()).toBeNull();
    expect(reads).toBe(2);
  });

  it("shows the refs of the latest read when an earlier one answers last", async () => {
    const answers: ((value: { branches: Branch[] } | Error) => void)[] = [];
    const { value } = services(viewWith(status()), {
      "git.diff": diff,
      "git.branches": () =>
        new Promise((resolve, reject) =>
          answers.push((answer) => (answer instanceof Error ? reject(answer) : resolve(answer))),
        ),
    });
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const picker = page.getByRole("combobox", { name: "Change comparison target. Currently main" });
    await userEvent.click(picker);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(picker);
    expect(answers).toHaveLength(2);
    const develop: Branch = {
      name: "develop",
      current: false,
      isDefault: false,
      isRemote: false,
      upstream: null,
    };
    await act(async () => answers[1]!({ branches: [develop] }));
    // The first read fails last: it was superseded, so neither its error nor its refs show.
    await act(async () => answers[0]!(new Error("too late")));
    await expect.element(page.getByRole("option", { name: "develop" })).toBeVisible();
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("folds a renamed file from its header", async () => {
    const renamed = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 80%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1,2 +1,2 @@",
      " const one = 1;",
      "-const two = 2;",
      "+const two = 3;",
      "",
    ].join("\n");
    const { value } = services(viewWith(status()), {
      "git.diff": { ...diff, patch: renamed },
    });
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    await expect.element(page.getByRole("button", { name: "Expand src/new.ts" })).toBeVisible();
    // Neither the chevron nor the name: the counts in the header. They are only reachable in
    // Pierre's shadow DOM (@pierre/diffs 1.5.2: diffs-container, [data-diffs-header],
    // [data-title], [data-metadata]); an upgrade that renames them fails here first.
    const header = [...document.querySelectorAll("diffs-container")]
      .flatMap((host) => [...(host.shadowRoot?.querySelectorAll("[data-diffs-header]") ?? [])])
      .find(
        (element) => element.querySelector("[data-title]")?.textContent?.trim() === "src/new.ts",
      );
    const metadata = header?.querySelector("[data-metadata]") as HTMLElement | null | undefined;
    expect(metadata).toBeTruthy();
    act(() => metadata!.click());
    await expect.element(page.getByRole("button", { name: "Collapse src/new.ts" })).toBeVisible();
    // And back: the same click folds it again.
    act(() => metadata!.click());
    await expect.element(page.getByRole("button", { name: "Expand src/new.ts" })).toBeVisible();
  });

  it("compares with the base chosen in T3's picker", async () => {
    const branches: Branch[] = [
      { name: "feature/toolbar", current: true, isDefault: false, isRemote: false, upstream: null },
      { name: "main", current: false, isDefault: true, isRemote: false, upstream: "origin/main" },
      { name: "develop", current: false, isDefault: false, isRemote: false, upstream: null },
      { name: "origin/main", current: false, isDefault: false, isRemote: true, upstream: null },
      { name: "origin/release", current: false, isDefault: false, isRemote: true, upstream: null },
    ];
    const { value, calls } = services(viewWith(status()), {
      "git.diff": (params: { base?: string }) => ({ ...diff, baseRef: params.base ?? "main" }),
      "git.branches": { branches },
    });
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    await userEvent.click(
      page.getByRole("combobox", { name: "Change comparison target. Currently main" }),
    );
    await expect.element(page.getByRole("option", { name: "develop" })).toBeVisible();
    expect(page.getByRole("option", { name: "Automatic" }).element()).toBeTruthy();
    expect(page.getByRole("switch", { name: "Use remote version of main" }).element()).toBeTruthy();
    expect(page.getByRole("img", { name: "Remote only" }).element()).toBeTruthy();
    // The checked-out branch is no base for itself.
    expect(page.getByRole("option", { name: "feature/toolbar" }).query()).toBeNull();
    await userEvent.click(page.getByRole("option", { name: "develop" }));
    await expect
      .element(page.getByRole("combobox", { name: "Change comparison target. Currently develop" }))
      .toBeVisible();
    expect(calls.findLast((call) => call.method === "git.diff")?.params).toEqual({
      threadId: "t1",
      scope: "branch",
      ignoreWhitespace: true,
      base: "develop",
    });
    mounted.unmount();
  });

  it("offers a contributed scope in the menu, after the turns, in its group", async () => {
    const { value, scopes } = services(viewWith(status()), { "git.diff": diff });
    const loads: unknown[] = [];
    const reviews: DiffScopeProvider = {
      id: "test.reviews",
      order: 20,
      // A fresh array on every call: the panel compares what the options say.
      options: () => [
        { value: "review:last", label: "Last review" },
        { value: "review:1", label: "Review 1", group: "Review", detail: "10:00" },
      ],
      load: async (context, option) => {
        loads.push({ projectId: context.projectId, threadId: context.threadId, option });
        return {
          ...diff,
          patch: patch.split("diff --git a/docs")[0]!,
          baseRef: null,
          headRef: null,
        };
      },
    };
    const registration = scopes.register(reviews);
    const Panel = createDiffPanel(value).DiffPanel;
    const mounted = mount(<Panel />);
    await userEvent.click(page.getByRole("button", { name: "Diff scope: Changes" }));
    expect(
      page
        .getByRole("menuitemradio")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["Changes", "Uncommitted", "Latest turn", "Last review"]);
    await userEvent.click(page.getByRole("menuitem", { name: "Review" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: /Review 1/ }));
    await expect.element(page.getByRole("button", { name: "Diff scope: Review 1" })).toBeVisible();
    expect(loads).toEqual([{ projectId: "app", threadId: "t1", option: "review:1" }]);
    await expect.element(page.getByRole("button", { name: "Expand src/app.ts" })).toBeVisible();
    // A scope that goes away falls back to the first one.
    act(() => registration.dispose());
    await expect.element(page.getByRole("button", { name: "Diff scope: Changes" })).toBeVisible();
    mounted.unmount();
  });

  it("keeps the diff it shows when a refresh fails", async () => {
    let reads = 0;
    const { value } = services(viewWith(status()), {
      "git.diff": () => {
        reads++;
        if (reads > 1) throw new Error("git is busy");
        return diff;
      },
    });
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    await expect.element(page.getByRole("button", { name: "Expand src/app.ts" })).toBeVisible();
    // The window regaining focus reads the diff again, as T3 does.
    act(() => window.dispatchEvent(new Event("focus")));
    await expect.element(page.getByText("git is busy")).toBeVisible();
    expect(page.getByRole("button", { name: "Expand src/app.ts" }).element()).toBeTruthy();
    expect(reads).toBe(2);
  });

  it("opens a file's name in the preferred editor, and others from its context menu", async () => {
    localStorage.removeItem("jhin.lastEditor");
    // The project is the repository's `src` folder: its files open relative to it.
    const { value, calls } = services(
      viewWith(status()),
      {
        "git.diff": diff,
        "editors.list": {
          editors: [
            { id: "vscode", label: "VS Code" },
            { id: "zed", label: "Zed" },
            { id: "file-manager", label: "File Manager" },
          ],
          revealKind: "finder",
        },
        "editors.open": (params: { editor: string; path: string }) => params,
      },
      deviceConfig(),
      "/src/app/src",
    );
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const title = page.getByText("src/app.ts", { exact: true });
    await expect.element(title).toBeVisible();
    await userEvent.click(title);
    const opens = () => calls.filter((call) => call.method === "editors.open");
    expect(opens().map((call) => call.params)).toEqual([
      { projectId: "app", path: "app.ts", editor: "vscode" },
    ]);
    // A file outside the project's folder opens nowhere, as in T3.
    await userEvent.click(page.getByText("docs/notes.md", { exact: true }));
    expect(opens()).toHaveLength(1);

    // T3's "Reveal in …", worded by the node's file manager (D922).
    await userEvent.click(title, { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(opens().at(-1)?.params).toEqual({
      projectId: "app",
      path: "app.ts",
      editor: "file-manager",
      reveal: true,
    });
    // Revealing never makes the file manager the preferred editor.
    expect(localStorage.getItem("jhin.lastEditor")).toBe("vscode");
    await userEvent.click(title, { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Open with" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Zed" }));
    expect(opens().at(-1)?.params).toEqual({ projectId: "app", path: "app.ts", editor: "zed" });
    // The editor chosen last is the one a name opens in next.
    expect(localStorage.getItem("jhin.lastEditor")).toBe("zed");
    localStorage.removeItem("jhin.lastEditor");
  });

  it("says why a file did not open, retries a failed editor list, and folds a name that opens nowhere", async () => {
    localStorage.removeItem("jhin.lastEditor");
    let lists = 0;
    const { value, shown, calls } = services(viewWith(status()), {
      "git.diff": diff,
      "editors.list": () => {
        lists++;
        if (lists === 1) throw new Error("not connected yet");
        // A node from before D922: no reveal kind.
        return {
          editors: [
            { id: "zed", label: "Zed" },
            { id: "file-manager", label: "File Manager" },
          ],
        };
      },
      "editors.open": () => {
        throw new Error("Could not start zed: spawn EACCES");
      },
    });
    const editors = createEditors(value.threads, value.toasts);
    const Panel = createDiffPanel({ ...value, editors }).DiffPanel;
    const mounted = mount(<Panel />);
    const title = page.getByText("src/app.ts", { exact: true });
    await expect.element(title).toBeVisible();
    // The first list failed: the name folds its file instead of opening it.
    await userEvent.click(title);
    await expect.element(page.getByRole("button", { name: "Collapse src/app.ts" })).toBeVisible();
    expect(calls.filter((call) => call.method === "editors.open")).toHaveLength(0);
    mounted.unmount();

    // A view that follows the node again reads the list again.
    mount(<Panel />);
    await expect.element(page.getByText("src/app.ts", { exact: true })).toBeVisible();
    expect(lists).toBe(2);
    await userEvent.click(page.getByText("src/app.ts", { exact: true }));
    // The refused call settles, then its toast is shown.
    await act(async () => undefined);
    await act(async () => undefined);
    expect(shown[0]).toEqual({
      type: "error",
      title: "Could not open in Zed",
      description: "src/app.ts: Could not start zed: spawn EACCES",
    });
    // An editor that failed to open is not remembered as the preferred one.
    expect(localStorage.getItem("jhin.lastEditor")).toBeNull();
    // A failed reveal says so in T3's words (D922).
    await editors.open(
      { node: "a" },
      "app",
      "app.ts",
      { id: "file-manager", label: "File Manager" },
      { reveal: true },
    );
    expect(shown.at(-1)).toEqual({
      type: "error",
      title: "Unable to reveal file",
      description: "app.ts: Could not start zed: spawn EACCES",
    });
    // Without a reveal kind the node cannot reveal: its menu opens the folder, as before.
    await userEvent.click(page.getByText("src/app.ts", { exact: true }), { button: "right" });
    await expect
      .element(page.getByRole("menuitem", { name: "Open containing folder" }))
      .toBeVisible();
    expect(page.getByRole("menuitem", { name: /^Reveal in/ }).query()).toBeNull();
  });

  it("sends a comment on lines into the composer, as T3 sends a review comment", async () => {
    const inserted: string[] = [];
    const config = deviceConfig(
      { filesCollapsed: false },
      {
        "chat.composer.insert": (input) => {
          inserted.push((input as { text: string }).text);
          return { inserted: true };
        },
      },
    );
    const { value } = services(viewWith(status()), { "git.diff": diff }, config);
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const line = page.getByText("const two = 3;");
    await expect.element(line).toBeVisible();
    await userEvent.hover(line);
    expect(visiblePlusButtons()).toHaveLength(1);
    await userEvent.click(page.elementLocator(visiblePlusButtons()[0]!));
    const box = page.getByRole("textbox", { name: "Comment on lines +2" });
    await expect.element(box).toBeVisible();
    await userEvent.fill(box, "Why three?");
    await userEvent.click(page.getByRole("button", { name: "Comment", exact: true }));
    await expect.element(box).not.toBeInTheDocument();
    expect(inserted).toEqual([
      [
        '<review_comment sectionId="jhin.source-control.git:branch" sectionTitle="Changes" filePath="src/app.ts" rangeLabel="+2" startIndex="2" endIndex="2">',
        "Why three?",
        "",
        "```diff",
        "@@ -0,0 +2,1 @@",
        "+const two = 3;",
        "```",
        "</review_comment>",
      ].join("\n"),
    ]);
  });

  it("adds a comment as its record and chip, shows it on its lines and deletes it (D1284–D1286)", async () => {
    let records: MessageContextRecord[] = [];
    const listeners = new Set<() => void>();
    const changed = () => act(() => listeners.forEach((listener) => listener()));
    const drafts: ChatDrafts = {
      hasThreadDraft: () => records.length > 0,
      contexts: (_target, threadId) => (threadId === "t1" ? records : []),
      subscribe: (listener) => {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    };
    const removed: string[] = [];
    const config = deviceConfig(
      { filesCollapsed: false },
      {
        "chat.composer.insert": () => {
          throw new Error("A chat that takes records gets no text");
        },
        "chat.composer.insert-context": (input) => {
          records = [...records, (input as { record: MessageContextRecord }).record];
          changed();
          return { inserted: true };
        },
        "chat.composer.remove-context": (input) => {
          const { contextId } = input as { contextId: string };
          removed.push(contextId);
          records = records.filter((record) => record.contextId !== contextId);
          changed();
          return { removed: true };
        },
      },
    );
    const { value } = services(
      viewWith(status()),
      { "git.diff": diff },
      config,
      "/src/app",
      drafts,
    );
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const line = page.getByText("const two = 3;");
    await expect.element(line).toBeVisible();
    await userEvent.hover(line);
    await userEvent.click(page.elementLocator(visiblePlusButtons()[0]!));
    const box = page.getByRole("textbox", { name: "Comment on lines +2" });
    await userEvent.fill(box, "Why three?");
    await userEvent.click(page.getByRole("button", { name: "Comment", exact: true }));
    await expect.element(box).not.toBeInTheDocument();
    expect(records).toHaveLength(1);
    const record = records[0] as ReviewCommentContextRecord;
    expect(record).toMatchObject({
      version: 1,
      kind: "review-comment",
      label: "app.ts L2",
      sectionId: "jhin.source-control.git:branch",
      sectionTitle: "Changes",
      filePath: "src/app.ts",
      rangeLabel: "+2",
      startIndex: 2,
      endIndex: 2,
      text: "Why three?",
      diff: "@@ -0,0 +2,1 @@\n+const two = 3;",
    });
    expect(record.contextId).toMatch(/^review-comment_/);
    // The comment in the message shows under its lines, as T3's annotation.
    await expect.element(page.getByText("Why three?")).toBeVisible();
    await userEvent.hover(page.getByText("Why three?"));
    await userEvent.click(page.getByRole("button", { name: "Delete comment" }));
    expect(removed).toEqual([record.contextId]);
    await expect.element(page.getByText("Why three?")).not.toBeInTheDocument();
  });

  it("closes a draft when the scope changes, and offers comments once a chat plugin comes", async () => {
    const commands: Record<string, (input: unknown) => unknown> = {};
    const config = deviceConfig({ filesCollapsed: false }, commands);
    const { value } = services(viewWith(status()), { "git.diff": diff }, config);
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const line = page.getByText("const two = 3;");
    await expect.element(line).toBeVisible();
    await userEvent.hover(line);
    expect(visiblePlusButtons()).toEqual([]);

    // The chat plugin activates after the panel: its command makes lines take comments.
    commands["chat.composer.insert"] = () => ({ inserted: true });
    act(() => config.context.events.emit("kernel.plugin.activated"));
    await userEvent.hover(page.getByText("const one = 1;"));
    await userEvent.hover(line);
    expect(visiblePlusButtons()).toHaveLength(1);
    await userEvent.click(page.elementLocator(visiblePlusButtons()[0]!));
    const box = page.getByRole("textbox", { name: "Comment on lines +2" });
    await expect.element(box).toBeVisible();

    // Another scope: the draft is gone, and so is the block on new comments.
    const key = selectionKey({ target, projectId: "app", threadId: "t1" });
    act(() => value.selections.update(key, { value: "uncommitted" }));
    await expect.element(box).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Diff scope: Uncommitted" }))
      .toBeVisible();
    await expect.element(line).toBeVisible();
    await userEvent.hover(line);
    expect(visiblePlusButtons()).toHaveLength(1);
  });

  it("sends with ⌘/Ctrl Enter, cancels with Escape, and says why a comment did not go", async () => {
    const answers: (() => unknown)[] = [
      () => ({ inserted: false }),
      () => {
        throw new Error("composer is busy");
      },
      () => "yes",
    ];
    const config = deviceConfig(
      { filesCollapsed: false },
      {
        "chat.composer.insert": () => answers.shift()!(),
      },
    );
    const { value, shown } = services(viewWith(status()), { "git.diff": diff }, config);
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const line = page.getByText("const two = 3;");
    const open = async () => {
      await expect.element(line).toBeVisible();
      await userEvent.hover(line);
      await userEvent.click(page.elementLocator(visiblePlusButtons()[0]!));
      return page.getByRole("textbox", { name: "Comment on lines +2" });
    };

    // Escape cancels.
    let box = await open();
    await userEvent.fill(box, "never mind");
    await userEvent.keyboard("{Escape}");
    await expect.element(box).not.toBeInTheDocument();

    // ⌘/Ctrl Enter sends; no message box on screen.
    box = await open();
    await userEvent.fill(box, "first");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await act(async () => undefined);
    await act(async () => undefined);
    expect(shown[0]).toEqual({ type: "info", title: "No message box to add the comment to" });

    // The composer refuses.
    await userEvent.click(page.getByRole("button", { name: "Comment", exact: true }));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(shown[1]).toEqual({
      type: "error",
      title: "Could not add the comment to the chat",
      description: "composer is busy",
    });

    // An answer the panel does not understand is an error, not "no message box".
    await userEvent.click(page.getByRole("button", { name: "Comment", exact: true }));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(shown[2]).toEqual({
      type: "error",
      title: "Could not add the comment to the chat",
      description: "The composer gave an answer the panel does not understand.",
    });
  });

  it("says so when the lines commented on left the diff after a refresh", async () => {
    let answer: Diff = diff;
    const inserted: string[] = [];
    const config = deviceConfig(
      { filesCollapsed: false },
      {
        "chat.composer.insert": (input) => {
          inserted.push((input as { text: string }).text);
          return { inserted: true };
        },
      },
    );
    const { value, shown } = services(viewWith(status()), { "git.diff": () => answer }, config);
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const line = page.getByText("const two = 3;");
    await expect.element(line).toBeVisible();
    await userEvent.hover(line);
    await userEvent.click(page.elementLocator(visiblePlusButtons()[0]!));
    const box = page.getByRole("textbox", { name: "Comment on lines +2" });
    await userEvent.fill(box, "Why three?");
    // The file is still changed, but only its first line now.
    answer = {
      ...diff,
      patch: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-const one = 1;",
        "+const one = 0;",
        "",
      ].join("\n"),
    };
    act(() => window.dispatchEvent(new Event("focus")));
    await expect.element(page.getByText("const one = 0;")).toBeVisible();
    // The draft closes and says why, rather than sending lines that are no longer there.
    await expect.element(box).not.toBeInTheDocument();
    expect(inserted).toEqual([]);
    expect(shown).toEqual([
      {
        type: "info",
        title: "These lines are no longer in the diff",
        description: "Comment on them again where they are now; your text is kept.",
      },
    ]);
    // And a new comment starts with the text typed.
    await userEvent.hover(page.getByText("const one = 0;"));
    expect(visiblePlusButtons()).toHaveLength(1);
    await userEvent.click(page.elementLocator(visiblePlusButtons()[0]!));
    await expect
      .element(page.getByRole("textbox", { name: /^Comment on lines/ }))
      .toHaveValue("Why three?");
  });

  it("holds a comment on its way: no Cancel, and a scope change hears nothing of it", async () => {
    let answer!: (value: { inserted: boolean }) => void;
    const inserted: string[] = [];
    const config = deviceConfig(
      { filesCollapsed: false },
      {
        "chat.composer.insert": (input) => {
          inserted.push((input as { text: string }).text);
          return new Promise((resolve) => (answer = resolve));
        },
      },
    );
    const { value, shown } = services(viewWith(status()), { "git.diff": diff }, config);
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    const line = page.getByText("const two = 3;");
    await expect.element(line).toBeVisible();
    await userEvent.hover(line);
    await userEvent.click(page.elementLocator(visiblePlusButtons()[0]!));
    const box = page.getByRole("textbox", { name: "Comment on lines +2" });
    await userEvent.fill(box, "Why three?");
    await userEvent.click(page.getByRole("button", { name: "Comment", exact: true }));
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(box.element()).toHaveProperty("readOnly", true);
    expect(inserted).toHaveLength(1);

    // Another scope closes the draft; the late answer then changes nothing and says nothing.
    const key = selectionKey({ target, projectId: "app", threadId: "t1" });
    act(() => value.selections.update(key, { value: "uncommitted" }));
    await expect.element(box).not.toBeInTheDocument();
    await act(async () => answer({ inserted: false }));
    expect(shown).toEqual([]);
  });

  it("says so when the project is no repository or has no changes", async () => {
    const Plain = createDiffPanel(
      services(viewWith(status({ isRepo: false, branch: null }))).value,
    ).DiffPanel;
    const first = mount(<Plain />);
    expect(first.container.textContent).toContain(
      "Turn diffs are unavailable because this project is not a git repository.",
    );
    first.unmount();

    const Clean = createDiffPanel(
      services(viewWith(status()), { "git.diff": { ...diff, patch: "", files: [] } }).value,
    ).DiffPanel;
    const second = mount(<Clean />);
    await expect.element(page.getByText("No net changes in this selection.")).toBeVisible();
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

  it("shows the repository's forge mark on its pull request action (D904)", () => {
    const quickMark = (provider: ProjectStatus["provider"]) => {
      const { value } = services(
        viewWith(
          status({
            workingTree: changed,
            upstream: "origin/feature/toolbar",
            pullRequests: {},
            provider,
          }),
        ),
      );
      const Control = createGitActionsControl(value);
      const view = mount(<Control project={project} target={target} thread={thread} />);
      const svg = view.container.querySelector('[role="group"] button svg')!;
      const seen = {
        forge: svg.getAttribute("data-forge"),
        hidden: svg.getAttribute("aria-hidden"),
        drawn: svg.childElementCount > 0,
      };
      view.unmount();
      return seen;
    };
    for (const kind of ["github", "gitlab", "azure-devops", "bitbucket", "forgejo"] as const) {
      expect(quickMark({ kind, available: true })).toEqual({
        forge: kind,
        hidden: "true",
        drawn: true,
      });
    }
    expect(quickMark(null)).toEqual({ forge: "none", hidden: "true", drawn: true });
  });

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

describe("checkpoints in the client", () => {
  const checkpoint = (turn: number, fields: Partial<TurnCheckpoint> = {}): TurnCheckpoint => ({
    threadId: "t1",
    turnId: `turn-${turn}`,
    turn,
    ref: `refs/jhin/checkpoints/t1/${turn}`,
    status: "ready",
    files: [],
    fileCount: 0,
    insertions: 0,
    deletions: 0,
    capturedAt: "2026-10-20T10:00:00.000Z",
    ...fields,
  });
  const second = checkpoint(2, {
    files: [
      { path: "src/a.ts", status: "modified", insertions: 5, deletions: 2, binary: false },
      { path: "src/lib/b.ts", status: "added", insertions: 2, deletions: 0, binary: false },
    ],
    fileCount: 2,
    insertions: 7,
    deletions: 2,
  });
  const withCheckpoints = (...checkpoints: TurnCheckpoint[]): SourceControlView => ({
    // Another branch is checked out: the card counts the latest turn all the same.
    ...viewWith(status({ branch: "main" })),
    checkpoints: new Map(checkpoints.map((item) => [item.threadId, item])),
  });
  const turnDiff: Diff = {
    projectId: "app",
    scope: "turn",
    baseRef: null,
    headRef: null,
    fromTurn: 1,
    turn: 2,
    patch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
    truncated: false,
    files: second.files,
    insertions: 7,
    deletions: 2,
  };

  it("counts the thread's latest turn on its card", () => {
    const { DiffCount } = createCardIndicators(services(withCheckpoints(second)).value);
    const card = mount(<DiffCount active={false} target={target} thread={thread} />);
    expect(card.container.textContent).toBe("+7 −2");
    card.unmount();

    // A latest turn whose changes are unknown: the uncommitted changes of the checkout.
    const failed = createCardIndicators(
      services({
        ...viewWith(status()),
        checkpoints: new Map([["t1", checkpoint(3, { status: "error" })]]),
      }).value,
    );
    const fallback = mount(<failed.DiffCount active={false} target={target} thread={thread} />);
    expect(fallback.container.textContent).toBe("+1,234 −5");
    fallback.unmount();

    // A latest turn that changed nothing shows nothing, whatever is uncommitted.
    const quiet = createCardIndicators(services(withCheckpoints(checkpoint(3))).value);
    const empty = mount(<quiet.DiffCount active={false} target={target} thread={thread} />);
    expect(empty.container.textContent).toBe("");
    empty.unmount();
  });

  const threadKey = selectionKey({ target, projectId: "app", threadId: "t1" });

  it("shows the latest turn's diff, names an earlier one by its number, and reveals a file", async () => {
    const { value, calls } = services(withCheckpoints(second), {
      "git.checkpoints": { checkpoints: [checkpoint(1), second] },
      "git.diff": turnDiff,
    });
    value.selections.update(threadKey, { value: "latest" });
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    await expect.element(page.getByRole("button", { name: "Expand src/a.ts" })).toBeVisible();
    expect(page.getByRole("button", { name: "Diff scope: Latest turn" }).element()).toBeTruthy();
    expect(calls).toContainEqual({
      method: "git.diff",
      params: { threadId: "t1", scope: "turn", turn: 2, ignoreWhitespace: true },
    });
    // Each turn is in T3's "Turn" submenu, with its time.
    await userEvent.click(page.getByRole("button", { name: "Diff scope: Latest turn" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Turn" }));
    await expect.element(page.getByRole("menuitemradio", { name: /^Turn 2/ })).toBeVisible();
    expect(
      page
        .getByRole("menuitemradio", { name: /^Turn \d/ })
        .elements()
        .map((item) => item.textContent),
    ).toEqual(
      ["Turn 2", "Turn 1"].map(
        (label) => `${label}${formatShortTimestamp("2026-10-20T10:00:00.000Z", "24-hour")}`,
      ),
    );
    await userEvent.click(page.getByRole("menuitemradio", { name: /^Turn 1/ }));
    await expect.element(page.getByRole("button", { name: "Diff scope: Turn 1" })).toBeVisible();
    expect(calls).toContainEqual({
      method: "git.diff",
      params: { threadId: "t1", scope: "turn", turn: 1, ignoreWhitespace: true },
    });

    // A file asked for from outside (the changed files card) is unfolded.
    act(() =>
      value.selections.update(threadKey, { value: "latest", filePath: "src/a.ts", reveal: 1 }),
    );
    await expect.element(page.getByRole("button", { name: "Collapse src/a.ts" })).toBeVisible();
  });

  it("says when a thread has no completed turns", async () => {
    const failed = checkpoint(1, { status: "error" });
    const { value } = services(withCheckpoints(failed), {
      "git.checkpoints": { checkpoints: [failed] },
    });
    value.selections.update(threadKey, { value: "latest" });
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    await expect.element(page.getByText("No completed turns yet.")).toBeVisible();
  });

  it("shows a turn's changed files under it and opens the diff panel on one", async () => {
    const { value } = services(withCheckpoints(second), {
      "git.checkpoints": { checkpoints: [checkpoint(1), second] },
    });
    const opened: string[] = [];
    const Footer = createChangedFilesFooter(value, (_target, threadId) => opened.push(threadId));
    const footer = mount(
      <Footer latest state="completed" target={target} thread={thread} turnId="turn-2" />,
    );
    await act(async () => undefined);
    await act(async () => undefined);
    const card = footer.container.querySelector('[aria-label="Changed files"]')!;
    expect(card.textContent).toContain("2 changed files");
    expect(card.querySelector('[aria-label="7 additions, 2 deletions"]')).not.toBeNull();
    const file = [...card.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("b.ts"),
    )!;
    // T3's file icons (D923): a TypeScript file shows TypeScript's.
    expect(file.querySelector("svg[data-pierre-icon]")?.getAttribute("data-icon-token")).toBe(
      "typescript",
    );
    act(() => file.click());
    expect(opened).toEqual(["t1"]);
    // The latest turn is "Latest turn", as T3 names it.
    expect(value.selections.get(threadKey)).toEqual({
      value: "latest",
      filePath: "src/lib/b.ts",
      reveal: 1,
    });
    footer.unmount();

    // A turn that changed nothing, or one still running, has no card.
    const none = mount(
      <Footer latest state="completed" target={target} thread={thread} turnId="turn-1" />,
    );
    await act(async () => undefined);
    expect(none.container.textContent).toBe("");
    none.unmount();
  });

  it("offers a changed file's context menu: Reveal in Finder and Open with (D905)", async () => {
    const { value, calls } = services(withCheckpoints(second), {
      "git.checkpoints": { checkpoints: [checkpoint(1), second] },
      "editors.list": {
        editors: [
          { id: "zed", label: "Zed" },
          { id: "file-manager", label: "File Manager" },
        ],
        revealKind: "finder",
      },
      "editors.open": (params: unknown) => params,
    });
    const Footer = createChangedFilesFooter(value, () => undefined);
    mount(<Footer latest state="completed" target={target} thread={thread} turnId="turn-2" />);
    const file = page.getByRole("button", { name: /b\.ts/ });
    await expect.element(file).toBeVisible();
    const opens = () => calls.filter((call) => call.method === "editors.open").map((c) => c.params);

    await userEvent.click(file, { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Reveal in Finder" }));
    expect(opens()).toEqual([
      { projectId: "app", path: "src/lib/b.ts", editor: "file-manager", reveal: true },
    ]);
    await userEvent.click(file, { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Open with" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Zed" }));
    expect(opens().at(-1)).toEqual({ projectId: "app", path: "src/lib/b.ts", editor: "zed" });
    localStorage.removeItem("jhin.lastEditor");

    // A folder's row has no menu.
    await userEvent.click(page.getByRole("button", { name: /^lib/ }), { button: "right" });
    await act(async () => undefined);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // The same steps on the file do open it: the check above waited long enough.
    await userEvent.click(file, { button: "right" });
    await expect.element(page.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();
  });

  it("offers no file menu for a file outside the project's folder, nor without editors (D905)", async () => {
    const outside = services(
      withCheckpoints(second),
      {
        "git.checkpoints": { checkpoints: [checkpoint(1), second] },
        "editors.list": { editors: [{ id: "zed", label: "Zed" }], revealKind: "finder" },
      },
      deviceConfig(),
      // The project is the repository's `docs` folder: `src/lib/b.ts` is outside it.
      "/src/app/docs",
    );
    const Outside = createChangedFilesFooter(outside.value, () => undefined);
    const first = mount(
      <Outside latest state="completed" target={target} thread={thread} turnId="turn-2" />,
    );
    const file = page.getByRole("button", { name: /b\.ts/ });
    await expect.element(file).toBeVisible();
    await userEvent.click(file, { button: "right" });
    await act(async () => undefined);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    first.unmount();

    const none = services(withCheckpoints(second), {
      "git.checkpoints": { checkpoints: [checkpoint(1), second] },
      "editors.list": { editors: [], revealKind: "finder" },
    });
    const NoEditors = createChangedFilesFooter(none.value, () => undefined);
    mount(<NoEditors latest state="completed" target={target} thread={thread} turnId="turn-2" />);
    await expect.element(page.getByRole("button", { name: /b\.ts/ })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /b\.ts/ }), { button: "right" });
    await act(async () => undefined);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("the diff panel across scopes", () => {
  it("never shows a turn's diff under a git scope while that scope loads", async () => {
    const only: TurnCheckpoint = {
      threadId: "t1",
      turnId: "turn-1",
      turn: 1,
      ref: "refs/jhin/checkpoints/t1/1",
      status: "ready",
      files: [],
      fileCount: 1,
      insertions: 1,
      deletions: 0,
      capturedAt: "2026-10-20T10:00:00.000Z",
    };
    let answer!: (diff: Diff) => void;
    const turnPatch =
      "diff --git a/turn.ts b/turn.ts\n--- a/turn.ts\n+++ b/turn.ts\n@@ -0,0 +1 @@\n+t\n";
    const { value } = services(
      { ...viewWith(status()), checkpoints: new Map([["t1", only]]) },
      {
        "git.checkpoints": { checkpoints: [only] },
        "git.diff": (params: { scope: string }) =>
          params.scope === "turn"
            ? { ...diffOf(turnPatch), scope: "turn" }
            : new Promise<Diff>((resolve) => (answer = resolve)),
      },
    );
    const key = selectionKey({ target, projectId: "app", threadId: "t1" });
    value.selections.update(key, { value: "latest" });
    const Panel = createDiffPanel(value).DiffPanel;
    mount(<Panel />);
    await expect.element(page.getByRole("button", { name: "Expand turn.ts" })).toBeVisible();

    act(() => value.selections.update(key, { value: "uncommitted" }));
    await expect
      .element(page.getByRole("status", { name: "Loading uncommitted changes..." }))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Expand turn.ts" }).query()).toBeNull();
    await act(async () => answer(diffOf("")));
    await expect.element(page.getByText("No net changes in this selection.")).toBeVisible();
  });
});

function diffOf(patch: string): Diff {
  return {
    projectId: "app",
    scope: "uncommitted",
    baseRef: null,
    headRef: null,
    patch,
    truncated: false,
    files: [],
    insertions: 0,
    deletions: 0,
  };
}

describe("worktrees in the client", () => {
  const settle = async () => {
    for (let index = 0; index < 3; index++) await act(async () => undefined);
  };

  it("marks a worktree thread's card with its folder and branch", () => {
    const Worktree = createWorktreeIndicator(services(viewWith(status(), "jhin/abcd1234")).value);
    const card = mount(
      <Worktree
        active={false}
        target={target}
        thread={{ ...thread, worktreePath: "/w/app/jhin-abcd1234" }}
      />,
    );
    expect(card.container.querySelector("[data-thread-worktree]")?.getAttribute("aria-label")).toBe(
      "Worktree: jhin-abcd1234 (jhin/abcd1234)",
    );
    card.unmount();
    const local = mount(<Worktree active={false} target={target} thread={thread} />);
    expect(local.container.textContent).toBe("");
    local.unmount();
  });

  it("lets a draft pick a new worktree and its base; a thread shows where it works", async () => {
    const { value } = services(viewWith(status()), {
      "git.branches": {
        branches: [
          {
            name: "feature/toolbar",
            current: true,
            isDefault: false,
            isRemote: false,
            upstream: null,
          },
          { name: "main", current: false, isDefault: true, isRemote: false, upstream: null },
        ],
      },
    });
    const drafts = createDraftWorkspaces();
    const Toolbar = createBranchToolbar(value, drafts);
    const project = { id: "app", name: "app", path: "/src/app", scratch: false, createdAt: "" };
    const draft = mount(<Toolbar project={project} target={target} />);
    const workspace = draft.container.querySelector<HTMLElement>('[aria-label="Workspace"]')!;
    expect(workspace.textContent).toContain("Current checkout");
    act(() => workspace.click());
    await settle();
    const worktree = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes("New worktree"),
    )!;
    act(() => worktree.click());
    await settle();
    expect(workspace.textContent).toContain("New worktree");
    expect(
      draft.container.querySelector('[aria-label="Branch From feature/toolbar"]'),
    ).not.toBeNull();
    expect(drafts.get(draftKey(target, "app"))).toEqual({
      mode: "worktree",
      baseRef: "feature/toolbar",
      startFromOrigin: false,
    });
    act(() =>
      drafts.set(draftKey(target, "app"), {
        ...drafts.get(draftKey(target, "app")),
        startFromOrigin: true,
      }),
    );
    expect(
      draft.container.querySelector('[aria-label="Branch From origin/feature/toolbar"]'),
    ).not.toBeNull();
    draft.unmount();

    const started = mount(
      <Toolbar
        project={project}
        target={target}
        thread={{ ...thread, worktreePath: "/w/app/jhin-abcd1234" }}
      />,
    );
    expect(started.container.querySelector('[aria-label="Workspace: Worktree"]')).not.toBeNull();
    started.unmount();
  });

  it("checks a pull request out from the branch search into the draft's worktree (D903)", async () => {
    const checkedOut: unknown[] = [];
    const { value, calls } = services(
      viewWith(status({ provider: { kind: "github", available: true } })),
      {
        "git.branches": { branches: [] },
        "git.pr.resolve": {
          pullRequest: { ...pr, number: 7, headBranch: "feature", baseBranch: "main" },
        },
        "git.pr.checkout": (params: unknown) => {
          checkedOut.push(params);
          return {
            pullRequest: pr,
            branch: "feature",
            worktreePath: "/w/app/feature",
            isOnPullRequestHead: true,
          };
        },
      },
    );
    const drafts = createDraftWorkspaces();
    const Toolbar = createBranchToolbar(value, drafts);
    const project = { id: "app", name: "app", path: "/src/app", scratch: false, createdAt: "" };
    mount(<Toolbar project={project} target={target} />);
    await userEvent.click(page.getByRole("combobox", { name: /^Branch / }));
    await userEvent.fill(page.getByRole("combobox", { name: "Search refs" }), "gh pr checkout #7");
    const option = page.getByRole("option", { name: /Checkout pull request/ });
    // GitHub's mark on the item and in the dialog's title (D904).
    expect(option.element().querySelector('svg[data-forge="github"]')).not.toBeNull();
    await userEvent.click(option);

    const dialog = page.getByRole("dialog", { name: "Checkout pull request" });
    await expect.element(dialog).toBeVisible();
    expect(
      dialog
        .getByRole("heading", { name: "Checkout pull request" })
        .element()
        .querySelector('svg[data-forge="github"]'),
    ).not.toBeNull();
    await expect.element(dialog.getByText(`#7 · feature to main`)).toBeVisible();
    expect(calls.find((call) => call.method === "git.pr.resolve")?.params).toEqual({
      projectId: "app",
      reference: "7",
    });
    // Clicked in the DOM, as the other dialogs here: without the app's styles the
    // dialog's backdrop is not stacked under it.
    await act(async () =>
      (dialog.getByRole("button", { name: "Worktree" }).element() as HTMLElement).click(),
    );
    await expect.element(dialog).not.toBeInTheDocument();
    expect(checkedOut).toEqual([{ projectId: "app", reference: "7", mode: "worktree" }]);
    expect(drafts.get(draftKey(target, "app"))).toEqual({
      mode: "previous",
      startFromOrigin: false,
      previous: { path: "/w/app/feature", branch: "feature" },
    });
  });

  it("says what a pull request reference needs, and offers no checkout off GitHub", async () => {
    const { value } = services(
      viewWith(status({ provider: { kind: "github", available: true } })),
      {
        "git.branches": { branches: [] },
      },
    );
    const Toolbar = createBranchToolbar(value, createDraftWorkspaces());
    const project = { id: "app", name: "app", path: "/src/app", scratch: false, createdAt: "" };
    const draft = mount(<Toolbar project={project} target={target} />);
    await userEvent.click(page.getByRole("combobox", { name: /^Branch / }));
    await userEvent.fill(page.getByRole("combobox", { name: "Search refs" }), "#12");
    await userEvent.click(page.getByRole("option", { name: /Checkout pull request/ }));
    const dialog = page.getByRole("dialog", { name: "Checkout pull request" });
    const input = dialog.getByRole("textbox");
    await userEvent.fill(input, "not a pr");
    await expect
      .element(dialog.getByText("Use a pull request URL, checkout command, 123, or #123."))
      .toBeVisible();
    await userEvent.fill(input, "");
    await expect
      .element(dialog.getByText("Paste a pull request URL, checkout command, or enter 123 / #123."))
      .toBeVisible();
    await act(async () =>
      (dialog.getByRole("button", { name: "Cancel" }).element() as HTMLElement).click(),
    );
    draft.unmount();

    const { value: plain } = services(viewWith(status({ provider: null })), {
      "git.branches": { branches: [] },
    });
    const Off = createBranchToolbar(plain, createDraftWorkspaces());
    mount(<Off project={project} target={target} />);
    await userEvent.click(page.getByRole("combobox", { name: /^Branch / }));
    await userEvent.fill(page.getByRole("combobox", { name: "Search refs" }), "#12");
    await expect.element(page.getByRole("option", { name: /Create new ref/ })).toBeVisible();
    expect(document.body.textContent).not.toContain("Checkout pull request");
  });

  it("asks again after a failed lookup once the reference is edited, and offers no checkout for a worktree's base", async () => {
    let failures = 1;
    const { value } = services(
      viewWith(status({ provider: { kind: "github", available: true } })),
      {
        "git.branches": { branches: [] },
        "git.pr.resolve": () => {
          if (failures-- > 0) throw new Error("gh exited with code 1");
          return { pullRequest: { ...pr, number: 7, headBranch: "feature", baseBranch: "main" } };
        },
      },
    );
    const drafts = createDraftWorkspaces();
    const Toolbar = createBranchToolbar(value, drafts);
    const project = { id: "app", name: "app", path: "/src/app", scratch: false, createdAt: "" };
    const draft = mount(<Toolbar project={project} target={target} />);
    await userEvent.click(page.getByRole("combobox", { name: /^Branch / }));
    await userEvent.fill(page.getByRole("combobox", { name: "Search refs" }), "#7");
    await userEvent.click(page.getByRole("option", { name: /Checkout pull request/ }));
    const dialog = page.getByRole("dialog", { name: "Checkout pull request" });
    await expect.element(dialog.getByText("gh exited with code 1")).toBeVisible();
    await userEvent.fill(dialog.getByRole("textbox"), "#7");
    await expect.element(dialog.getByText("#7 · feature to main")).toBeVisible();
    await act(async () =>
      (dialog.getByRole("button", { name: "Cancel" }).element() as HTMLElement).click(),
    );
    draft.unmount();

    act(() =>
      drafts.set(draftKey(target, "app"), {
        mode: "worktree",
        baseRef: "feature/toolbar",
        startFromOrigin: false,
      }),
    );
    mount(<Toolbar project={project} target={target} />);
    await userEvent.click(page.getByRole("combobox", { name: /^Branch From/ }));
    await userEvent.fill(page.getByRole("combobox", { name: "Search refs" }), "#7");
    await expect.element(page.getByText("No refs found.")).toBeVisible();
    expect(document.body.textContent).not.toContain("Checkout pull request");
  });

  it("holds the dialog while preparing, takes Enter for Worktree and leaves a local checkout's draft as it was", async () => {
    let finish!: (prepared: unknown) => void;
    const modes: unknown[] = [];
    const { value } = services(
      viewWith(status({ provider: { kind: "github", available: true } })),
      {
        "git.branches": { branches: [] },
        "git.pr.resolve": {
          pullRequest: { ...pr, number: 7, headBranch: "feature", baseBranch: "main" },
        },
        "git.pr.checkout": (params: { mode: string }) => {
          modes.push(params.mode);
          return new Promise((resolve) => (finish = resolve));
        },
      },
    );
    const drafts = createDraftWorkspaces();
    const Toolbar = createBranchToolbar(value, drafts);
    const project = { id: "app", name: "app", path: "/src/app", scratch: false, createdAt: "" };
    mount(<Toolbar project={project} target={target} />);
    const open = async () => {
      await userEvent.click(page.getByRole("combobox", { name: /^Branch / }));
      await userEvent.fill(page.getByRole("combobox", { name: "Search refs" }), "#7");
      await userEvent.click(page.getByRole("option", { name: /Checkout pull request/ }));
      const dialog = page.getByRole("dialog", { name: "Checkout pull request" });
      await expect.element(dialog.getByText("#7 · feature to main")).toBeVisible();
      return dialog;
    };

    // Enter is Worktree; while it runs the dialog says so and stays.
    let dialog = await open();
    await userEvent.type(dialog.getByRole("textbox"), "{Enter}");
    await expect
      .element(dialog.getByRole("button", { name: "Preparing worktree..." }))
      .toBeVisible();
    expect(modes).toEqual(["worktree"]);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).toBeVisible();
    await act(async () =>
      finish({
        pullRequest: pr,
        branch: "feature",
        worktreePath: "/w/app/feature",
        isOnPullRequestHead: true,
      }),
    );
    await expect.element(dialog).not.toBeInTheDocument();

    // Local leaves the draft in the project's own checkout.
    dialog = await open();
    await act(async () =>
      (dialog.getByRole("button", { name: "Local" }).element() as HTMLElement).click(),
    );
    await expect.element(dialog.getByRole("button", { name: "Preparing local..." })).toBeVisible();
    await act(async () =>
      finish({ pullRequest: pr, branch: "feature", worktreePath: null, isOnPullRequestHead: true }),
    );
    await expect.element(dialog).not.toBeInTheDocument();
    expect(modes).toEqual(["worktree", "local"]);
    expect(drafts.get(draftKey(target, "app"))).toEqual({ mode: "local", startFromOrigin: false });
  });

  it("opens a draft's workspace menu for T3's composer.workspace, and nothing for a started thread (D906)", async () => {
    const { value } = services(viewWith(status()), { "git.branches": { branches: [] } });
    const drafts = createDraftWorkspaces();
    const Toolbar = createBranchToolbar(value, drafts);
    const project = { id: "app", name: "app", path: "/src/app", scratch: false, createdAt: "" };
    // A started thread's toolbar alone: its fixed label offers no menu.
    const started = mount(<Toolbar project={project} target={target} thread={thread} />);
    await expect.element(page.getByRole("img", { name: /^Workspace: / })).toBeVisible();
    expect(drafts.run("workspace")).toBe(false);

    // A draft beside it offers its menu, and takes it back when it goes.
    const draft = mount(<Toolbar project={project} target={target} />);
    await expect.element(page.getByRole("button", { name: "Workspace" })).toBeVisible();
    let opened = false;
    act(() => {
      opened = drafts.run("workspace");
    });
    expect(opened).toBe(true);
    await expect.element(page.getByRole("menuitemradio", { name: /New worktree/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    draft.unmount();
    expect(drafts.run("workspace")).toBe(false);
    started.unmount();
  });

  it("opens the branch picker and takes the previous worktree for T3's composer shortcuts (D907)", async () => {
    const focused: unknown[] = [];
    const { value, calls } = services(
      viewWith(status()),
      { "git.branches": { branches: [] } },
      deviceConfig({}, { "chat.composer.focus": (input) => focused.push(input) }),
    );
    // Another thread of the project works in a worktree: the draft's previous one.
    (value.threads.catalog(target).threads as ThreadRecord[]).push({
      ...thread,
      id: "t2",
      worktreePath: "/w/app/feature",
    });
    const drafts = createDraftWorkspaces();
    const Toolbar = createBranchToolbar(value, drafts);
    const project = { id: "app", name: "app", path: "/src/app", scratch: false, createdAt: "" };
    // Another project's draft: no thread of its own works in a worktree, nothing to take.
    const other = { ...project, id: "other" };
    (value.store.view(target).projects as Map<string, ProjectStatus>).set(
      "other",
      status({ projectId: "other" }),
    );
    const lone = mount(<Toolbar project={other} target={target} />);
    await expect.element(page.getByRole("button", { name: "Workspace" })).toBeVisible();
    expect(drafts.run("previous-worktree")).toBe(false);
    lone.unmount();

    const draft = mount(<Toolbar project={project} target={target} />);
    await expect.element(page.getByRole("button", { name: "Workspace" })).toBeVisible();
    let used = false;
    act(() => {
      used = drafts.run("previous-worktree");
    });
    expect(used).toBe(true);
    expect(drafts.get(draftKey(target, "app"))).toMatchObject({
      mode: "previous",
      previous: { path: "/w/app/feature" },
    });
    // The composer gets the focus back, as T3's usePreviousWorktree gives it.
    expect(focused).toEqual([{}]);
    act(() => {
      drafts.run("branch");
    });
    await expect.element(page.getByRole("combobox", { name: "Search refs" })).toBeVisible();
    expect(calls.some((call) => call.method === "git.branches")).toBe(true);
    await userEvent.keyboard("{Escape}");
    draft.unmount();

    // A started thread has no previous worktree to take, but its branch picker opens.
    mount(<Toolbar project={project} target={target} thread={thread} />);
    await expect.element(page.getByRole("img", { name: /^Workspace: / })).toBeVisible();
    expect(drafts.run("previous-worktree")).toBe(false);
    let opened = false;
    act(() => {
      opened = drafts.run("branch");
    });
    expect(opened).toBe(true);
    await expect.element(page.getByRole("combobox", { name: "Search refs" })).toBeVisible();
  });

  it("never offers to delete a worktree this node did not make", async () => {
    const asked: string[] = [];
    let around!: (
      input: ThreadDeleteInput,
      next: (input: ThreadDeleteInput) => Promise<boolean>,
    ) => Promise<boolean>;
    const context = {
      hooks: {
        around: (_name: string, hook: typeof around) => {
          around = hook;
          return toDisposable(() => undefined);
        },
      },
    } as unknown as PluginContext;
    const threads = {
      catalog: () => ({ status: "ready", projects: [], threads: [] }),
      subscribe: () => toDisposable(() => undefined),
      call: async () => ({
        worktrees: [{ path: "/home/me/by-hand", managed: false, threadIds: ["t1"] }],
      }),
      open: async () => "",
    } as unknown as ThreadsCatalog;
    registerWorktreeCleanup(
      context,
      threads,
      {
        confirm: async (options) => {
          asked.push(options.title);
          return true;
        },
        prompt: async () => undefined,
      },
      undefined,
    );
    expect(
      await around(
        { target, thread: { ...thread, worktreePath: "/home/me/by-hand" } },
        async () => true,
      ),
    ).toBe(true);
    expect(asked).toEqual([]);
  });

  it("deletes a worktree only its thread used, after the thread, when asked", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const catalog: NodeCatalog = {
      status: "ready",
      projects: [],
      threads: [{ ...thread, worktreePath: "/w/app/jhin-abcd1234" }],
    };
    const threads: ThreadsCatalog = {
      catalog: () => catalog,
      subscribe: () => toDisposable(() => undefined),
      call: async <T,>(_target: unknown, method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "git.worktree.list") {
          return {
            worktrees: [{ path: "/w/app/jhin-abcd1234", managed: true, threadIds: ["t1"] }],
          } as T;
        }
        return undefined as T;
      },
      open: async () => "",
    };
    let around!: (
      input: ThreadDeleteInput,
      next: (input: ThreadDeleteInput) => Promise<boolean>,
    ) => Promise<boolean>;
    const context = {
      hooks: {
        around: (_name: string, hook: typeof around) => {
          around = hook;
          return toDisposable(() => undefined);
        },
      },
    } as unknown as PluginContext;
    const asked: string[] = [];
    const dialogs = {
      confirm: async (options: { title: string; description?: string }) => {
        asked.push(`${options.title} ${options.description}`);
        return true;
      },
      prompt: async () => undefined,
    };
    registerWorktreeCleanup(context, threads, dialogs, undefined);
    const deleted = await around({ target, thread: catalog.threads[0]! }, async () => {
      calls.push({ method: "threads.delete", params: {} });
      return true;
    });
    expect(deleted).toBe(true);
    expect(asked).toEqual([
      "Delete the worktree too? This thread is the only one linked to this worktree:\njhin-abcd1234\n\nIts uncommitted changes are lost; its branch stays.",
    ]);
    expect(calls).toEqual([
      { method: "git.worktree.list", params: { projectId: "app" } },
      { method: "threads.delete", params: {} },
      {
        method: "git.worktree.remove",
        params: { projectId: "app", path: "/w/app/jhin-abcd1234", force: true },
      },
    ]);
  });
});
