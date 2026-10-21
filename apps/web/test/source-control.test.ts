import type {
  Connections,
  NodeCatalog,
  NodeConnection,
  NodeTarget,
  ThreadCreateInput,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type PluginContext } from "@jhin/sdk";
import {
  SOURCE_CONTROL_STREAM,
  SourceControlEvents,
  type Branch,
  type ProjectStatus,
  type StatusSnapshot,
  type ThreadPullRequest,
  type TurnCheckpoint,
} from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

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
  buildBaseRefChoices,
  filterBaseRefChoices,
} from "../src/plugins/source-control/diff/base-refs.ts";
import {
  buildDiffFileTreeUpdates,
  collectDirectoryPaths,
  diffFileTreeEntries,
  diffFileTreePositions,
} from "../src/plugins/source-control/diff/file-tree-logic.ts";
import {
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../src/plugins/source-control/diff/rendering.ts";
import {
  preferredEditor,
  resolveDiffPathForWorkspace,
} from "../src/plugins/source-control/diff/editors.tsx";
import {
  buildDiffReviewComment,
  serializeReviewComment,
} from "../src/plugins/source-control/diff/review-comment.ts";
import {
  createDiffScopes,
  createDiffSelections,
  gitScopeProvider,
  selectionKey,
} from "../src/plugins/source-control/diff/scopes.ts";
import {
  applySourceControlEvent,
  createSourceControlStore,
  type SourceControlView,
} from "../src/plugins/source-control/store.ts";
import {
  createDraftWorkspaces,
  draftKey,
  previousWorktree,
  registerWorkspaceHook,
} from "../src/plugins/source-control/workspace.tsx";

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
    worktrees: new Map(),
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
    worktrees: new Map(),
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
    // After a revert, the turn gone back to is the latest again.
    const reverted = applySourceControlEvent(
      applySourceControlEvent(second, {
        type: SourceControlEvents.checkpointChanged,
        payload: checkpoint(2, { status: "stale" }),
      }),
      { type: SourceControlEvents.checkpointChanged, payload: checkpoint(1) },
    );
    expect(reverted.checkpoints.get("t1")).toMatchObject({ turn: 1, status: "ready" });
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

/**
 * A node: answers `git.status` from `answer`, records subscriptions to its
 * stream. `relay` is how it answers `mesh.relay` for a member: with the
 * relay's name, or with the error it throws.
 */
function fakeNode(
  answer: (params: unknown) => Promise<unknown>,
  relay: (params: { node: string; stream: string }) => Promise<unknown> = async ({
    node,
    stream,
  }) => ({ stream: `relay/${node}/${stream}` }),
) {
  const subscriptions: {
    disposed: boolean;
    stream: string;
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
      if (!stream.endsWith(SOURCE_CONTROL_STREAM)) throw new Error(`unexpected stream ${stream}`);
      const entry = {
        disposed: false,
        stream,
        after: options.after,
        onEvent,
        onError: options.onError,
      };
      subscriptions.push(entry);
      for (const resolve of waiting.splice(0)) resolve();
      return { lastSequence: 0, dispose: () => void (entry.disposed = true) };
    },
    call: async (method: string, params: unknown) => {
      if (method !== "mesh.relay") throw new Error(`unexpected call ${method}`);
      return relay(params as { node: string; stream: string });
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
      // The stream goes on from the head the answer reflects (what it skipped is trimmed).
      const head = (result as { head?: unknown } | null)?.head;
      if (typeof head === "number") sequence = head;
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
      for (const { onEvent, disposed } of subscriptions) {
        if (disposed) continue;
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
    // Later events of the same tick are not applied either, nor do they start over again.
    node.append(SourceControlEvents.statusChanged, status({ ahead: 98 }), 1);
    // Not applied: read again instead (head 8) and followed from there.
    expect((await reloaded).projects.get("app")?.ahead).toBe(8);
    await node.subscribed(2);
    expect(node.subscriptions.map((entry) => entry.after)).toEqual([4, 8]);
    // The subscription that saw the gap is gone; only the new one follows.
    expect(node.subscriptions.map((entry) => entry.disposed)).toEqual([true, false]);
    expect(node.calls).toHaveLength(2);
    const followed = feed.next();
    node.append(SourceControlEvents.statusChanged, status({ ahead: 11 }));
    expect((await followed).projects.get("app")?.ahead).toBe(11);
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

  it("follows a mesh member's stream through the connection's relay (D503)", async () => {
    const node = fakeNode(async () => snapshot(3));
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const target = { node: "ws://a/rpc", remote: "node-c" };
    const feed = follow(store, target);
    expect((await feed.next()).status).toBe("ready");
    await node.subscribed();
    expect(node.subscriptions.map(({ stream, after }) => [stream, after])).toEqual([
      ["relay/node-c/source-control", 3],
    ]);
    const changed = feed.next();
    node.append(SourceControlEvents.statusChanged, status({ ahead: 7 }));
    expect((await changed).projects.get("app")?.ahead).toBe(7);
    // git.status went to the member.
    expect(node.calls.every((call) => call.target.remote === "node-c")).toBe(true);
    store.dispose();
  });

  const member = { node: "ws://a/rpc", remote: "node-c" };
  const branchAt = (head: number) => snapshot(head, [status({ branch: `b${head}` })]);

  it("reads a mesh member again on catalog changes when the connection has no relays (D118)", async () => {
    let head = 0;
    const node = fakeNode(
      async () => branchAt(++head),
      async () => {
        throw Object.assign(new Error("no relays"), { code: "COMMAND_NOT_FOUND" });
      },
    );
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const feed = follow(store, member);
    expect((await feed.next()).projects.get("app")?.branch).toBe("b1");
    const next = feed.next();
    node.catalogChanged();
    expect((await next).projects.get("app")?.branch).toBe("b2");
    expect(node.subscriptions).toHaveLength(0);
    expect(node.calls.every((call) => call.target.remote === "node-c")).toBe(true);
    store.dispose();
  });

  it("drops the relay and reads again on catalog changes when the member shares nothing (D118)", async () => {
    let head = 0;
    const node = fakeNode(async () => branchAt(++head));
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const feed = follow(store, member);
    expect((await feed.next()).projects.get("app")?.branch).toBe("b1");
    await node.subscribed();
    const reread = feed.next();
    node.subscriptions[0]!.onError?.(
      Object.assign(new Error("not shared"), { code: "STREAM_NOT_SHARED" }),
    );
    expect((await reread).projects.get("app")?.branch).toBe("b2");
    expect(node.subscriptions.map((entry) => entry.disposed)).toEqual([true]);
    const next = feed.next();
    node.catalogChanged();
    expect((await next).projects.get("app")?.branch).toBe("b3");
    store.dispose();
  });

  it("shows another relay failure and starts over, following the relay then", async () => {
    let relays = 0;
    const node = fakeNode(
      async () => snapshot(3),
      async ({ node: owner, stream }) => {
        if (++relays === 1) {
          throw Object.assign(new Error("node-c cannot be reached"), {
            code: "NODE_UNREACHABLE",
          });
        }
        return { stream: `relay/${owner}/${stream}` };
      },
    );
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const feed = follow(store, member);
    const seen: SourceControlView[] = [];
    while (!seen.some((view) => view.status === "error")) seen.push(await feed.next());
    expect(seen.find((view) => view.status === "error")?.error).toBe("node-c cannot be reached");
    await node.subscribed();
    expect(node.subscriptions.map(({ stream, after }) => [stream, after])).toEqual([
      ["relay/node-c/source-control", 3],
    ]);
    store.dispose();
  });

  it("starts a member's feed over when its relayed stream skips events (D498)", async () => {
    let head = 0;
    const node = fakeNode(async () => snapshot((head += 4), [status({ ahead: head })]));
    const store = createSourceControlStore(node.connections, node.threads, quiet);
    const feed = follow(store, member);
    await feed.next();
    await node.subscribed();
    const reloaded = feed.next();
    node.append(SourceControlEvents.statusChanged, status({ ahead: 99 }), 1);
    expect((await reloaded).projects.get("app")?.ahead).toBe(8);
    await node.subscribed(2);
    expect(node.subscriptions.map(({ stream, after }) => [stream, after])).toEqual([
      ["relay/node-c/source-control", 4],
      ["relay/node-c/source-control", 8],
    ]);
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

describe("reading a patch for the diff panel", () => {
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
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000..ce01362",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/src/old.ts b/src/lib/renamed.ts",
    "similarity index 100%",
    "rename from src/old.ts",
    "rename to src/lib/renamed.ts",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");

  it("parses files with Pierre, each with its path and change", () => {
    const parsed = getRenderablePatch(patch, "test");
    expect(parsed?.kind).toBe("files");
    const files = parsed?.kind === "files" ? parsed.files : [];
    expect(files.map((file) => [resolveFileDiffPath(file), file.type])).toEqual([
      ["README.md", "change"],
      ["src/new.ts", "new"],
      ["src/lib/renamed.ts", "rename-pure"],
      ["gone.txt", "deleted"],
    ]);
    expect(getDiffLineStat(files)).toEqual({ additions: 2, deletions: 2 });
    expect(getRenderablePatch("", "test")).toBeNull();
    expect(getRenderablePatch("not a patch", "test")).toEqual({
      kind: "raw",
      text: "not a patch",
      reason: "Unsupported diff format. Showing raw patch.",
    });
  });

  it("lists the files for T3's file tree in the diff's order, with their git status", () => {
    const parsed = getRenderablePatch(patch, "test");
    const entries = diffFileTreeEntries(parsed?.kind === "files" ? parsed.files : []);
    expect(entries).toEqual([
      { path: "README.md", status: "modified" },
      { path: "src/new.ts", status: "added" },
      { path: "src/lib/renamed.ts", status: "renamed" },
      { path: "gone.txt", status: "deleted" },
    ]);
    const paths = entries.map((entry) => entry.path);
    expect(collectDirectoryPaths(paths)).toEqual(["src/", "src/lib/"]);
    expect([...diffFileTreePositions(paths)]).toEqual([
      ["README.md", 0],
      ["src/new.ts", 1],
      ["src/", 1],
      ["src/lib/renamed.ts", 2],
      ["src/lib/", 2],
      ["gone.txt", 3],
    ]);
    // A refreshed diff: deepest directories go first, new ones come before their files.
    expect(buildDiffFileTreeUpdates(paths, ["README.md", "docs/a/b.md"])).toEqual([
      { type: "remove", path: "src/new.ts" },
      { type: "remove", path: "src/lib/renamed.ts" },
      { type: "remove", path: "gone.txt" },
      { type: "remove", path: "src/lib/", recursive: true },
      { type: "remove", path: "src/", recursive: true },
      { type: "add", path: "docs/" },
      { type: "add", path: "docs/a/" },
      { type: "add", path: "docs/a/b.md" },
    ]);
  });
});

describe("a comment on lines, as T3 sends it", () => {
  it("escapes its attributes and fences a diff holding backticks", () => {
    expect(
      serializeReviewComment({
        sectionId: "turn:1",
        sectionTitle: 'Turn "1" <a&b>',
        filePath: "docs/a.md",
        startIndex: 0,
        endIndex: 1,
        rangeLabel: "+1 to +2",
        text: "Use a code block",
        diff: "@@ -0,0 +1,2 @@\n+```ts\n+```",
      }),
    ).toBe(
      [
        '<review_comment sectionId="turn:1" sectionTitle="Turn &quot;1&quot; &lt;a&amp;b&gt;" filePath="docs/a.md" rangeLabel="+1 to +2" startIndex="0" endIndex="1">',
        "Use a code block",
        "",
        "````diff",
        "@@ -0,0 +1,2 @@",
        "+```ts",
        "+```",
        "````",
        "</review_comment>",
      ].join("\n"),
    );
  });

  it("labels a range of a file's diff by its lines", () => {
    const parsed = getRenderablePatch(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        "",
      ].join("\n"),
      "test",
    );
    const fileDiff = parsed?.kind === "files" ? parsed.files[0]! : undefined;
    const comment = buildDiffReviewComment({
      sectionId: "s",
      sectionTitle: "Changes",
      filePath: "a.ts",
      fileDiff: fileDiff!,
      range: { start: 2, side: "deletions", end: 2, endSide: "additions" },
      text: "  why?  ",
    });
    expect(comment).toMatchObject({
      rangeLabel: "2",
      text: "why?",
      diff: "@@ -2,1 +2,1 @@\n-two\n+TWO",
    });
  });
});

describe("the base ref picker's choices", () => {
  const branch = (name: string, isRemote = false): Branch => ({
    name,
    current: false,
    isDefault: false,
    isRemote,
    upstream: null,
  });

  it("pairs a local branch with its remote one, origin first, then lists remote-only ones", () => {
    const choices = buildBaseRefChoices(
      [branch("main"), branch("develop")],
      [branch("fork/main", true), branch("origin/main", true), branch("origin/release", true)],
    );
    expect(
      choices.map((choice) => [choice.id, choice.label, choice.local?.name, choice.remote?.name]),
    ).toEqual([
      ["local:main", "main", "main", "origin/main"],
      ["local:develop", "develop", "develop", undefined],
      ["remote:fork/main", "fork/main", undefined, "fork/main"],
      ["remote:origin/release", "origin/release", undefined, "origin/release"],
    ]);
    expect(filterBaseRefChoices(choices, " REL ").map((choice) => choice.label)).toEqual([
      "origin/release",
    ]);
    expect(filterBaseRefChoices(choices, "fork").map((choice) => choice.label)).toEqual([
      "fork/main",
    ]);
  });
});

describe("opening a diff's file", () => {
  it("resolves repository paths inside the project's folder, as T3 does", () => {
    const resolve = (filePath: string, workspaceRoot?: string) =>
      resolveDiffPathForWorkspace({ filePath, workspaceRoot, repositoryRoot: "/repo" });
    expect(resolve("src/a.ts", "/repo")).toBe("src/a.ts");
    expect(resolve("web/src/a.ts", "/repo/web/")).toBe("src/a.ts");
    expect(resolve("api/a.ts", "/repo/web")).toBeNull();
    expect(resolve("../a.ts", "/repo")).toBeNull();
    expect(resolve("/etc/passwd", "/repo")).toBeNull();
    expect(resolve("a.ts", "/elsewhere")).toBeNull();
    expect(resolve("a.ts")).toBe("a.ts");
  });

  it("prefers the editor chosen last, else the first one found that is no file manager", () => {
    const editors = [
      { id: "file-manager", label: "File Manager" },
      { id: "cursor", label: "Cursor" },
      { id: "zed", label: "Zed" },
    ];
    const stored = (value: string | null) => ({ getItem: () => value });
    expect(preferredEditor(editors, stored(null))?.id).toBe("cursor");
    expect(preferredEditor(editors, stored("zed"))?.id).toBe("zed");
    expect(preferredEditor(editors, stored("vscode"))?.id).toBe("cursor");
    expect(preferredEditor([editors[0]!], stored(null))).toBeUndefined();
  });
});

describe("the diff panel's scopes", () => {
  it("orders providers and drops one when its registration is disposed", () => {
    const scopes = createDiffScopes();
    let changes = 0;
    scopes.subscribe(() => changes++);
    const load = async () => ({
      patch: "",
      truncated: false,
      insertions: 0,
      deletions: 0,
      baseRef: null,
      headRef: null,
    });
    const turns = scopes.register({ id: "turns", order: 10, options: () => [], load });
    scopes.register({ id: "git", order: 0, options: () => [], load });
    expect(scopes.providers().map((provider) => provider.id)).toEqual(["git", "turns"]);
    expect(() => scopes.register({ id: "git", options: () => [], load })).toThrow(
      "A diff scope provider git is already registered",
    );
    turns.dispose();
    turns.dispose();
    expect(scopes.providers().map((provider) => provider.id)).toEqual(["git"]);
    expect(changes).toBe(3);
  });

  it("asks git for T3's Changes against the chosen base, and for Uncommitted", async () => {
    const calls: unknown[] = [];
    const threads = {
      call: async (_target: unknown, method: string, params: unknown) => {
        calls.push([method, params]);
        return {
          projectId: "app",
          scope: "branch",
          baseRef: "develop",
          headRef: "feature",
          patch: "p",
          truncated: false,
          files: [],
          insertions: 1,
          deletions: 2,
        };
      },
    } as unknown as ThreadsCatalog;
    const git = gitScopeProvider(threads);
    expect(git.options({ target: { node: "a" }, projectId: "app" })).toEqual([
      { value: "branch", label: "Changes", baseRefs: true },
      { value: "uncommitted", label: "Uncommitted" },
    ]);
    const context = { target: { node: "a" }, projectId: "app", threadId: "t1" };
    expect(await git.load(context, "branch", { ignoreWhitespace: true, base: "develop" })).toEqual({
      patch: "p",
      truncated: false,
      insertions: 1,
      deletions: 2,
      baseRef: "develop",
      headRef: "feature",
    });
    await git.load(context, "uncommitted", { ignoreWhitespace: false });
    expect(calls).toEqual([
      // A thread's diff is read where it works: its worktree when it has one (D251).
      ["git.diff", { threadId: "t1", scope: "branch", ignoreWhitespace: true, base: "develop" }],
      ["git.diff", { threadId: "t1", scope: "uncommitted", ignoreWhitespace: false }],
    ]);
  });

  it("keeps each thread's selection on the device, the base across scope changes", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    } as unknown as Storage;
    const selections = createDiffSelections(storage);
    const key = selectionKey({ target: { node: "a" }, projectId: "app", threadId: "t1" });
    expect(key).toBe("a|t1");
    expect(selectionKey({ target: { node: "a", remote: "b" }, projectId: "app" })).toBe(
      "a|b|draft|app",
    );
    selections.update(key, { base: "develop" });
    selections.update(key, { value: "uncommitted" });
    expect(createDiffSelections(storage).get(key)).toEqual({
      base: "develop",
      value: "uncommitted",
    });
    selections.update(key, { base: undefined });
    expect(selections.get(key)).toEqual({ value: "uncommitted" });

    // What storage holds is checked: a malformed entry is dropped, not passed to git as a base.
    stored.set(
      "jhin.diff-panel.v1",
      JSON.stringify({ good: { base: "main" }, bad: { base: 5 }, odd: "x" }),
    );
    const read = createDiffSelections(storage);
    expect([read.get("good"), read.get("bad"), read.get("odd")]).toEqual([
      { base: "main" },
      {},
      {},
    ]);
    // A request to reveal a file is not kept across pages.
    read.update("good", { filePath: "src/a.ts", reveal: 3 });
    expect(JSON.parse(stored.get("jhin.diff-panel.v1")!).good).toEqual({ base: "main" });
    // Only the most recent 200 are kept.
    for (let index = 0; index < 205; index++) read.update(`t${index}`, { value: "branch" });
    const kept = Object.keys(JSON.parse(stored.get("jhin.diff-panel.v1")!));
    expect(kept).toHaveLength(200);
    expect(kept.at(0)).toBe("t5");
    expect(kept.at(-1)).toBe("t204");
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
      worktrees: new Map(),
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

describe("worktrees in the client", () => {
  const empty: SourceControlView = {
    status: "ready",
    projects: new Map(),
    threads: new Map(),
    links: new Map(),
    checkpoints: new Map(),
    worktrees: new Map(),
  };

  it("follows the worktrees threads work in", () => {
    const changed = applySourceControlEvent(empty, {
      type: SourceControlEvents.worktreeChanged,
      payload: { ...status({ branch: "jhin/abcd1234" }), worktreePath: "/w/app/jhin-abcd1234" },
    });
    expect(changed.worktrees.get("/w/app/jhin-abcd1234")?.branch).toBe("jhin/abcd1234");
    const removed = applySourceControlEvent(changed, {
      type: SourceControlEvents.worktreeRemoved,
      payload: { worktreePath: "/w/app/jhin-abcd1234" },
    });
    expect(removed.worktrees.size).toBe(0);
  });

  it("offers the project's latest worktree thread as the previous worktree", () => {
    const thread = (id: string, fields: Partial<ThreadRecord>): ThreadRecord => ({
      id,
      projectId: "app",
      title: id,
      createdAt: "2026-10-20T10:00:00.000Z",
      ...fields,
    });
    const threads = [
      thread("old", { worktreePath: "/w/old", updatedAt: "2026-10-20T11:00:00.000Z" }),
      thread("new", { worktreePath: "/w/new", updatedAt: "2026-10-20T12:00:00.000Z" }),
      thread("gone", {
        worktreePath: "/w/gone",
        updatedAt: "2026-10-20T13:00:00.000Z",
        archivedAt: "2026-10-20T13:00:00.000Z",
      }),
      thread("local", { updatedAt: "2026-10-20T14:00:00.000Z" }),
      thread("other", { projectId: "else", worktreePath: "/w/else" }),
    ];
    expect(previousWorktree(threads, "app", (id) => (id === "new" ? "feature/new" : null))).toEqual(
      { path: "/w/new", branch: "feature/new" },
    );
    expect(previousWorktree([], "app", () => null)).toBeUndefined();
  });

  it("creates a draft's thread in the workspace chosen for it, once", async () => {
    const hooks: ((input: ThreadCreateInput) => ThreadCreateInput)[] = [];
    const context = {
      hooks: {
        before: (_name: string, hook: (input: ThreadCreateInput) => ThreadCreateInput) => {
          hooks.push(hook);
          return toDisposable(() => undefined);
        },
      },
    } as unknown as PluginContext;
    const drafts = createDraftWorkspaces();
    registerWorkspaceHook(context, drafts);
    const target = { node: "ws://a/rpc" };
    const input = { target, projectId: "app", params: { projectId: "app" } };
    expect(hooks[0]!(input)).toBe(input);

    drafts.set(draftKey(target, "app"), {
      mode: "worktree",
      baseRef: "main",
      startFromOrigin: true,
    });
    expect(hooks[0]!(input).params).toEqual({
      projectId: "app",
      workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
    });
    // Used up: the next draft starts in the checkout again.
    expect(drafts.get(draftKey(target, "app")).mode).toBe("local");

    drafts.set(draftKey(target, "app"), {
      mode: "previous",
      startFromOrigin: false,
      previous: { path: "/w/new", branch: null },
    });
    expect(hooks[0]!(input).params).toEqual({
      projectId: "app",
      workspace: { type: "existing_worktree", worktreePath: "/w/new" },
    });
  });
});
