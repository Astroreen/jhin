import type {
  Connections,
  NodeCatalog,
  NodeConnection,
  NodeTarget,
  ThreadsCatalog,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable } from "@jhin/sdk";
import {
  SOURCE_CONTROL_STREAM,
  SourceControlEvents,
  type ProjectStatus,
  type StatusSnapshot,
  type ThreadPullRequest,
  type TurnCheckpoint,
} from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { parsePatch } from "../src/lib/diff.ts";
import {
  currentPullRequest,
  threadPullRequestBadge,
  threadPullRequestBadgePresentation,
} from "../src/lib/pull-request.ts";
import { readPullRequestInput } from "../src/plugins/source-control/links.tsx";
import { splitForMiddleTruncate } from "../src/lib/middle-truncate.tsx";
import { formatCompactDiffCount, prStatusIndicator } from "../src/lib/pull-request.ts";
import { describeBranch } from "../src/plugins/source-control/branch-toolbar.tsx";
import {
  applySourceControlEvent,
  createSourceControlStore,
  type SourceControlView,
} from "../src/plugins/source-control/store.ts";

const status = (fields: Partial<ProjectStatus> = {}): ProjectStatus => ({
  projectId: "app",
  isRepo: true,
  root: "/src/app",
  branch: "feature",
  upstream: "origin/feature",
  ahead: 0,
  behind: 0,
  defaultBranch: "main",
  remoteUrl: "https://github.com/acme/app.git",
  workingTree: { files: [], fileCount: 0, insertions: 0, deletions: 0, truncated: false },
  provider: { kind: "github", available: true },
  pullRequests: {},
  checkedAt: "2026-10-19T10:00:00.000Z",
  ...fields,
});

const snapshot = (head: number, projects: ProjectStatus[] = [status()]): StatusSnapshot => ({
  head,
  projects,
  threads: [
    { threadId: "t1", projectId: "app", branch: "feature", at: "2026-10-19T10:00:00.000Z" },
  ],
});

describe("applySourceControlEvent", () => {
  const view: SourceControlView = {
    status: "ready",
    projects: new Map([["app", status()]]),
    threads: new Map(),
    links: new Map(),
    checkpoints: new Map(),
  };

  it("applies statuses and thread branches, and their removal", () => {
    const changed = applySourceControlEvent(view, {
      type: SourceControlEvents.statusChanged,
      payload: status({ branch: "main" }),
    });
    expect(changed.projects.get("app")?.branch).toBe("main");
    const withThread = applySourceControlEvent(changed, {
      type: SourceControlEvents.threadChanged,
      payload: { threadId: "t1", projectId: "app", branch: "main", at: "" },
    });
    expect(withThread.threads.get("t1")?.branch).toBe("main");
    const removed = applySourceControlEvent(
      applySourceControlEvent(withThread, {
        type: SourceControlEvents.threadRemoved,
        payload: { threadId: "t1" },
      }),
      { type: SourceControlEvents.projectRemoved, payload: { projectId: "app" } },
    );
    expect([removed.projects.size, removed.threads.size]).toEqual([0, 0]);
    expect(applySourceControlEvent(view, { type: "other", payload: {} })).toBe(view);
    expect(
      applySourceControlEvent(view, { type: SourceControlEvents.statusChanged, payload: null }),
    ).toBe(view);
  });
});

describe("checkpoints in the view", () => {
  const view: SourceControlView = {
    status: "ready",
    projects: new Map(),
    threads: new Map(),
    links: new Map(),
    checkpoints: new Map(),
  };
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

  it("keeps each thread's latest checkpoint, and drops it with the thread", () => {
    const second = applySourceControlEvent(
      applySourceControlEvent(view, {
        type: SourceControlEvents.checkpointChanged,
        payload: checkpoint(1),
      }),
      { type: SourceControlEvents.checkpointChanged, payload: checkpoint(2, { insertions: 3 }) },
    );
    expect(second.checkpoints.get("t1")).toMatchObject({ turn: 2, insertions: 3 });
    // A change to an earlier turn is not the latest one.
    const stale = applySourceControlEvent(second, {
      type: SourceControlEvents.checkpointChanged,
      payload: checkpoint(1, { status: "stale" }),
    });
    expect(stale).toBe(second);
    // The latest turn's own change (reverted past) is.
    expect(
      applySourceControlEvent(second, {
        type: SourceControlEvents.checkpointChanged,
        payload: checkpoint(2, { status: "stale" }),
      }).checkpoints.get("t1")?.status,
    ).toBe("stale");
    const removed = applySourceControlEvent(second, {
      type: SourceControlEvents.threadRemoved,
      payload: { threadId: "t1" },
    });
    expect(removed.checkpoints.size).toBe(0);
  });
});

/** A node: answers `git.status` from `answer`, records subscriptions to its stream. */
function fakeNode(answer: (params: unknown) => Promise<unknown>) {
  const subscriptions: {
    after: number | undefined;
    onEvent: (event: StoredEvent) => void;
    onError: ((error: unknown) => void) | undefined;
  }[] = [];
  const waiting: (() => void)[] = [];
  const client = {
    state: "open",
    subscribe(
      stream: string,
      options: { after?: number; onError?: (error: unknown) => void },
      onEvent: (event: StoredEvent) => void,
    ) {
      if (stream !== SOURCE_CONTROL_STREAM) throw new Error(`unexpected stream ${stream}`);
      subscriptions.push({ after: options.after, onEvent, onError: options.onError });
      for (const resolve of waiting.splice(0)) resolve();
      return { lastSequence: 0, dispose: () => undefined };
    },
  } as unknown as RpcClient;
  const connection: NodeConnection = {
    id: "ws://a/rpc",
    url: "ws://a/rpc",
    label: "a",
    client,
    state: "open",
  };
  const connections: Connections = {
    list: () => [connection],
    get: (id) => (id === connection.id ? connection : undefined),
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
  const calls: { target: NodeTarget; method: string; params: unknown }[] = [];
  const catalogListeners = new Set<() => void>();
  let catalog: NodeCatalog = { status: "ready", projects: [], threads: [] };
  const threads: ThreadsCatalog = {
    catalog: () => catalog,
    subscribe: (_target, listener) => {
      catalogListeners.add(listener);
      return toDisposable(() => catalogListeners.delete(listener));
    },
    call: async <T>(target: NodeTarget, method: string, params?: unknown) => {
      calls.push({ target, method, params });
      const result = await answer(params);
      // The stream goes on from the head the answer reflects.
      const head = (result as { head?: unknown } | null)?.head;
      if (typeof head === "number") sequence = Math.max(sequence, head);
      return result as T;
    },
    open: async () => "",
  };
  let sequence = 0;
  return {
    connections,
    threads,
    calls,
    subscriptions,
    /** Resolves once the stream was subscribed to `count` times. */
    subscribed: (count = 1) =>
      subscriptions.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const check = () => (subscriptions.length >= count ? resolve() : waiting.push(check));
            waiting.push(check);
          }),
    append(type: string, payload: unknown, skip = 0) {
      sequence += 1 + skip;
      for (const { onEvent } of subscriptions) {
        onEvent({
          stream: SOURCE_CONTROL_STREAM,
          sequence,
          type,
          payload: payload as never,
          at: "",
        });
      }
    },
    /** The member's thread catalog changes (a turn ended). */
    catalogChanged() {
      catalog = { ...catalog };
      for (const listener of catalogListeners) listener();
    },
  };
}

const quiet = { warn: () => undefined };

/** Resolves with the next view of `target`. */
function follow(store: ReturnType<typeof createSourceControlStore>, target: NodeTarget) {
  const waiting: ((view: SourceControlView) => void)[] = [];
  const subscription = store.subscribe(target, () => waiting.shift()?.(store.view(target)));
  return {
    subscription,
    next: () => new Promise<SourceControlView>((resolve) => waiting.push(resolve)),
  };
}

describe("the source control store", () => {
  it("loads git.status, then follows the node's stream after the head it reflects", async () => {
    const node = fakeNode(async () => snapshot(4));
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const target = { node: "ws://a/rpc" };
    const feed = follow(store, target);
    expect(store.view(target).status).toBe("loading");
    const loaded = await feed.next();
    expect(loaded.status).toBe("ready");
    expect(loaded.threads.get("t1")?.branch).toBe("feature");

    await node.subscribed();
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([4]);
    const changed = feed.next();
    node.append(
      SourceControlEvents.statusChanged,
      status({
        workingTree: { files: [], fileCount: 1, insertions: 3, deletions: 1, truncated: false },
      }),
    );
    expect((await changed).projects.get("app")?.workingTree.insertions).toBe(3);
    feed.subscription.dispose();
    store.dispose();
  });

  it("starts over after the node refuses its stream: git.status again, then the stream", async () => {
    let head = 0;
    const node = fakeNode(async () => snapshot((head += 4)));
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const target = { node: "ws://a/rpc" };
    const feed = follow(store, target);
    await feed.next();
    await node.subscribed();
    const failed = feed.next();
    node.subscriptions[0]!.onError?.(Object.assign(new Error("refused"), { code: "INVALID" }));
    expect(await failed).toMatchObject({ status: "error", error: "refused" });
    // Loaded again (head 8) and following from there; events reach the view again.
    expect((await feed.next()).status).toBe("ready");
    await node.subscribed(2);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([4, 8]);
    const changed = feed.next();
    node.append(SourceControlEvents.statusChanged, status({ ahead: 5 }));
    expect((await changed).projects.get("app")?.ahead).toBe(5);
    feed.subscription.dispose();
    store.dispose();
  });

  it("starts over when its stream skips events it missed (D498)", async () => {
    let head = 0;
    const node = fakeNode(async () => snapshot((head += 4), [status({ ahead: head })]));
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const target = { node: "ws://a/rpc" };
    const feed = follow(store, target);
    await feed.next();
    await node.subscribed();
    // 5 is followed by 7: the node trimmed 6 before this client resumed.
    const changed = feed.next();
    node.append(SourceControlEvents.statusChanged, status({ ahead: 1 }));
    expect((await changed).projects.get("app")?.ahead).toBe(1);
    const reloaded = feed.next();
    node.append(SourceControlEvents.statusChanged, status({ ahead: 99 }), 1);
    // Not applied: read again instead (head 8) and followed from there.
    expect((await reloaded).projects.get("app")?.ahead).toBe(8);
    await node.subscribed(2);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([4, 8]);
    feed.subscription.dispose();
    store.dispose();
  });

  it("shows nothing for a node without the source control plugin", async () => {
    const node = fakeNode(async () => {
      throw Object.assign(new Error("Command git.status is not registered"), {
        code: "COMMAND_NOT_FOUND",
      });
    });
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const feed = follow(store, { node: "ws://a/rpc" });
    expect((await feed.next()).status).toBe("unavailable");
    expect(node.subscriptions).toEqual([]);
    store.dispose();
  });

  it("reads a mesh member again whenever its thread catalog changes", async () => {
    let head = 0;
    const node = fakeNode(async () => snapshot(++head, [status({ branch: `b${head}` })]));
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const target = { node: "ws://a/rpc", remote: "node-c" };
    const feed = follow(store, target);
    expect((await feed.next()).projects.get("app")?.branch).toBe("b1");
    const next = feed.next();
    node.catalogChanged();
    expect((await next).projects.get("app")?.branch).toBe("b2");
    // A member's stream is not shared (D26): nothing subscribes to it.
    expect(node.subscriptions).toEqual([]);
    expect(node.calls.every((call) => call.target.remote === "node-c")).toBe(true);
    store.dispose();
  });

  it("refreshes one project on request", async () => {
    const node = fakeNode(async (params) =>
      (params as { refresh?: boolean } | undefined)?.refresh === true
        ? snapshot(9, [status({ ahead: 2 })])
        : snapshot(1),
    );
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const target = { node: "ws://a/rpc" };
    const feed = follow(store, target);
    await feed.next();
    const refreshed = feed.next();
    await store.refresh(target, "app");
    expect((await refreshed).projects.get("app")?.ahead).toBe(2);
    expect(node.calls.at(-1)?.params).toEqual({ projectId: "app", refresh: true });
    store.dispose();
  });
});

describe("reading a patch", () => {
  it("splits files and hunks, numbering lines", () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "index 4c5fd91..2a5a1f9 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,3 @@ heading",
      " one",
      "-two",
      "+TWO",
      " three",
      "\\ No newline at end of file",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..ce01362",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/old.ts b/renamed.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to renamed.ts",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/image.png b/image.png",
      "Binary files a/image.png and b/image.png differ",
      "",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files.map((file) => [file.path, file.change, file.insertions, file.deletions])).toEqual([
      ["README.md", "modified", 1, 1],
      ["new.txt", "added", 1, 0],
      ["renamed.ts", "renamed", 0, 0],
      ["gone.txt", "deleted", 0, 1],
      ["image.png", "modified", 0, 0],
    ]);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: "context", text: "one", oldLine: 1, newLine: 1 },
      { kind: "delete", text: "two", oldLine: 2 },
      { kind: "add", text: "TWO", newLine: 2 },
      { kind: "context", text: "three", oldLine: 3, newLine: 3 },
      { kind: "note", text: "No newline at end of file" },
    ]);
    expect(files[2]!.previousPath).toBe("old.ts");
    expect(files[4]!.binary).toBe(true);
    expect(parsePatch("")).toEqual([]);
  });
});

describe("presenting source control", () => {
  it("keeps a branch's last segment whole when truncating in the middle", () => {
    expect(splitForMiddleTruncate("feature/source-control")).toEqual({
      head: "feature/",
      tail: "source-control",
    });
    expect(splitForMiddleTruncate("main")).toBeNull();
  });

  it("labels pull requests as T3 does", () => {
    const pr = {
      number: 12,
      title: "Ship it",
      url: "https://github.com/acme/app/pull/12",
      state: "open" as const,
      isDraft: true,
      headBranch: "feature",
      baseBranch: "main",
      checks: { state: null, passed: 0, failed: 0, pending: 0, total: 0 },
    };
    expect(prStatusIndicator(pr)).toMatchObject({
      label: "PR draft",
      tooltip: "PR #12 - Draft: Ship it",
    });
    expect(prStatusIndicator({ ...pr, state: "merged" })?.label).toBe("PR merged");
    expect(prStatusIndicator(null)).toBeNull();
    expect(formatCompactDiffCount(1234)).toBe("1.2k");
    expect(formatCompactDiffCount(56_000)).toBe("56k");
  });

  it("says where a branch stands against its upstream", () => {
    expect(describeBranch(status({ ahead: 2, behind: 1 }), "feature")).toBe(
      "feature · 2 ahead, 1 behind origin/feature",
    );
    expect(describeBranch(status(), "feature")).toBe("feature · up to date with origin/feature");
    expect(describeBranch(status({ upstream: null }), "feature")).toBe("feature · no upstream");
    expect(describeBranch(status(), "other")).toBe("other · checked out: feature");
  });
});

describe("linked pull requests", () => {
  const link = (number: number, fields: Record<string, unknown> = {}) =>
    ({
      key: `github.com/acme/app#${number}`,
      host: "github.com",
      repository: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      source: "created",
      linkedAt: `2026-10-0${number}T00:00:00Z`,
      snapshot: null,
      ...fields,
    }) as ThreadPullRequest;
  const pr = (head: string, base: string, state = "open", isDraft = false) => ({
    number: 0,
    title: head,
    url: "",
    state,
    isDraft,
    headBranch: head,
    baseBranch: base,
    checks: { state: null, passed: 0, failed: 0, pending: 0, total: 0 },
  });

  it("follows links, their updates and unlinks, and drops them with the thread", () => {
    const empty: SourceControlView = {
      status: "ready",
      projects: new Map(),
      threads: new Map(),
      links: new Map(),
      checkpoints: new Map(),
    };
    let view = applySourceControlEvent(empty, {
      type: "git.pr.linked",
      payload: { threadId: "t1", pullRequest: link(1) },
    });
    view = applySourceControlEvent(view, {
      type: "git.pr.updated",
      payload: { threadId: "t1", pullRequest: link(1, { snapshot: pr("a", "main") }) },
    });
    expect(view.links.get("t1")?.[0]?.snapshot?.headBranch).toBe("a");
    view = applySourceControlEvent(view, {
      type: "git.pr.linked",
      payload: { threadId: "t1", pullRequest: link(2) },
    });
    view = applySourceControlEvent(view, {
      type: "git.pr.unlinked",
      payload: { threadId: "t1", key: "github.com/acme/app#1" },
    });
    expect(view.links.get("t1")?.map((item) => item.number)).toEqual([2]);
    view = applySourceControlEvent(view, {
      type: "source-control.thread.removed",
      payload: { threadId: "t1" },
    });
    expect(view.links.size).toBe(0);
  });

  it("reads the card's badge as T3 does: a stack, several, one", () => {
    const stack = [
      link(1, { snapshot: pr("a", "main", "merged") }),
      link(2, { snapshot: pr("b", "a") }),
    ];
    const badge = threadPullRequestBadge(stack)!;
    expect(badge).toEqual({ kind: "stack", layers: 2, state: "open" });
    expect(currentPullRequest(stack)?.number).toBe(2);
    expect(threadPullRequestBadgePresentation(badge, currentPullRequest(stack))).toMatchObject({
      label: "Stack of 2 pull requests, open",
      text: 2,
    });
    const apart = [
      link(1, { snapshot: pr("a", "main", "merged") }),
      link(2, { snapshot: pr("x", "main", "closed") }),
    ];
    const several = threadPullRequestBadge(apart)!;
    expect(several).toEqual({ kind: "pull-request", others: 1, state: "closed" });
    expect(threadPullRequestBadgePresentation(several, apart[1])).toMatchObject({
      text: "+2",
      label: "PR #0 - Closed: x, and 1 more linked; overall closed",
    });
    expect(
      threadPullRequestBadgePresentation(threadPullRequestBadge([link(3)])!, link(3)),
    ).toMatchObject({ label: "PR #3, status pending", text: 3 });
    expect(
      threadPullRequestBadge([link(1, { snapshot: pr("a", "main", "open", true) })]),
    ).toMatchObject({ state: "draft" });
  });

  it("reads what the link dialog was given", () => {
    const remote = "git@github.com:acme/app.git";
    expect(readPullRequestInput("#42", remote)).toEqual({
      repository: "acme/app",
      number: 42,
      host: "github.com",
    });
    expect(readPullRequestInput(" https://github.com/acme/app/pull/7 ", remote)).toEqual({
      url: "https://github.com/acme/app/pull/7",
    });
    expect(readPullRequestInput("", remote)).toBe("Paste a pull request URL or enter 123 / #123.");
    expect(readPullRequestInput("nope", remote)).toBe("Use a pull request URL, 123, or #123.");
    expect(readPullRequestInput("12", null)).toBe("Use a pull request URL, 123, or #123.");
  });
});
