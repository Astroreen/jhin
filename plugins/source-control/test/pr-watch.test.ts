import type { PullRequestWatch, ThreadPullRequest } from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import {
  createLinks,
  createWatcher,
  evaluateWatch,
  startWatch,
  watchMessage,
} from "../src/index.ts";
import { fakeGh, ghPullRequest, git, node, repository } from "./support.ts";

const T0 = "2026-10-20T10:00:00Z";
const later = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const read = (fields: Partial<Parameters<typeof evaluateWatch>[1]> = {}) => ({
  state: "open" as const,
  headSha: "abcdef1234",
  baseBranch: "main",
  checks: [],
  mergeability: "mergeable" as const,
  author: "author",
  viewer: "jhin-bot",
  remarks: [],
  ...fields,
});

describe("evaluating a watch", () => {
  it("tells failed checks once, then that all passed after a new push", () => {
    let watch: PullRequestWatch = startWatch(T0);
    const failed = evaluateWatch(
      watch,
      read({
        checks: [
          { name: "test", status: "failure", url: "https://ci/1" },
          { name: "lint", status: "success" },
        ],
      }),
    );
    expect(failed.changes).toEqual([
      { kind: "checks-failed", failed: [{ name: "test", status: "failure", url: "https://ci/1" }] },
    ]);
    watch = failed.next;
    expect(
      evaluateWatch(watch, read({ checks: [{ name: "test", status: "failure" }] })).changes,
    ).toEqual([]);
    const fixed = evaluateWatch(
      watch,
      read({ headSha: "1234567fff", checks: [{ name: "test", status: "success" }] }),
    );
    expect(fixed.changes).toEqual([{ kind: "checks-passed", count: 1 }]);
    expect(
      watchMessage({
        number: 7,
        url: "https://x/7",
        baseBranch: "main",
        headSha: "1234567fff",
        report: fixed,
      }),
    ).toBe(
      [
        "Update on pull request #7 (https://x/7), which Jhin is watching for you:",
        "- All 1 check passed on 1234567.",
        "",
        "Look into each item and act on it as your task requires. Jhin keeps watching and wakes you on the next change, so end your turn when you are done. When you hand the work back to the user, call git_pr_unwatch first.",
      ].join("\n"),
    );
  });

  it("tells others' comments after the watch began, once, and a conflict", () => {
    const watch = startWatch(T0);
    const report = evaluateWatch(
      watch,
      read({
        mergeability: "conflicting",
        remarks: [
          {
            id: "1",
            author: "reviewer",
            body: "Please <!-- x --> rename   this",
            createdAt: later(1),
          },
          { id: "2", author: "jhin-bot", body: "mine", createdAt: later(2) },
          { id: "3", author: "author", body: "also mine", createdAt: later(2) },
          { id: "0", author: "reviewer", body: "old", createdAt: later(-1) },
          { id: "4", author: "reviewer", body: "", reviewState: "APPROVED", createdAt: later(1) },
        ],
      }),
    );
    expect(report.changes.map((change) => change.kind)).toEqual(["remarks", "conflicting"]);
    const text = watchMessage({ number: 7, url: "u", baseBranch: "main", headSha: null, report });
    expect(text).toContain(
      '- 2 new comments:\n  - reviewer: "Please rename this"\n  - reviewer: APPROVED',
    );
    expect(text).toContain("- The branch now conflicts with main.");
    // The same remarks and conflict again: nothing new.
    const again = evaluateWatch(
      report.next,
      read({
        mergeability: "conflicting",
        remarks: [{ id: "1", author: "reviewer", body: "x", createdAt: later(1) }],
      }),
    );
    expect(again.changes).toEqual([]);
  });

  it("stops after ten comment-only wakes in a row", () => {
    let watch = startWatch(T0);
    let exhausted = false;
    for (let index = 1; index <= 10; index += 1) {
      const report = evaluateWatch(
        watch,
        read({
          remarks: [{ id: String(index), author: "r", body: "hi", createdAt: later(index) }],
        }),
      );
      watch = report.next;
      exhausted = report.exhausted;
    }
    expect(exhausted).toBe(true);
  });
});

/** A thread's `agent.turn.started` whose text `match` accepts. */
const turnWith = (match: (text: string) => boolean) => (event: StoredEvent) =>
  event.type === "agent.turn.started" &&
  match(((event.payload as { input?: { text?: string } }).input?.text ?? "") as string);

describe("jhin.source-control: watching a pull request", () => {
  async function setup() {
    const gh = fakeGh();
    gh.view(
      7,
      ghPullRequest({
        headRefOid: "abcdef1234",
        mergeable: "MERGEABLE",
        author: { login: "author" },
      }),
    );
    const dir = repository();
    git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    const sc = await node({ watchSweepSeconds: 0 });
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    const turns: StoredEvent[] = [];
    const waiters = new Set<{ match: (event: StoredEvent) => boolean; resolve(): void }>();
    sc.client.subscribe(`thread/${thread.id}`, {}, (event) => {
      turns.push(event);
      for (const waiter of waiters) if (waiter.match(event)) waiter.resolve();
    });
    const until = (match: (event: StoredEvent) => boolean) =>
      new Promise<void>((resolve) => {
        if (turns.some(match)) resolve();
        else waiters.add({ match, resolve });
      });
    return { gh, sc, thread, turns, until };
  }

  it("wakes the thread when checks fail and someone comments, and stays quiet otherwise", async () => {
    const { gh, sc, thread, until } = await setup();
    const url = "https://github.com/acme/demo/pull/7";
    const watched = await sc.client.call<{ pullRequest: ThreadPullRequest; wasWatching: boolean }>(
      "git.pr.watch",
      { threadId: thread.id, url },
    );
    expect(watched).toMatchObject({
      watching: true,
      wasWatching: false,
      pullRequest: { source: "agent" },
    });
    expect(watched.pullRequest.watch).toMatchObject({ headSha: null, wakes: 0 });
    expect(await sc.client.call("git.pr.watch.check", { threadId: thread.id })).toEqual({
      checked: 1,
      woken: 0,
    });
    gh.view(
      7,
      ghPullRequest({
        headRefOid: "abcdef1234",
        author: { login: "author" },
        statusCheckRollup: [
          {
            name: "test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://ci/run/1",
          },
        ],
        comments: [
          {
            id: "c1",
            author: { login: "reviewer" },
            body: "Looks off",
            createdAt: "2099-01-01T00:00:00Z",
          },
        ],
      }),
    );
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 1 });
    await until(
      turnWith(
        (text) =>
          text.startsWith(`Update on pull request #7 (${url}), which Jhin is watching for you:`) &&
          text.includes("- Checks failed on abcdef1:\n  - test https://ci/run/1") &&
          text.includes('- 1 new comment:\n  - reviewer: "Looks off"'),
      ),
    );
    expect(gh.calls()).toContain("api --hostname github.com user");
    expect(await sc.client.call("git.pr.unwatch", { threadId: thread.id, url })).toMatchObject({
      watching: false,
      wasWatching: true,
    });
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 0, woken: 0 });
  });

  it("holds the news while a turn runs and sends it when the turn ends", async () => {
    const { gh, sc, thread, until } = await setup();
    const url = "https://github.com/acme/demo/pull/7";
    await sc.client.call("git.pr.watch", { threadId: thread.id, url });
    await sc.client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    gh.view(7, ghPullRequest({ headRefOid: "abcdef1234", mergeable: "CONFLICTING" }));
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 1 });
    await sc.client.call("threads.interrupt", { threadId: thread.id });
    await until(turnWith((text) => text.includes("- The branch now conflicts with main.")));
  });

  it("stops quietly on merge, and with a word when the pull request closes", async () => {
    const { gh, sc, thread, until } = await setup();
    const url = "https://github.com/acme/demo/pull/7";
    await sc.client.call("git.pr.watch", { threadId: thread.id, url });
    gh.view(7, ghPullRequest({ state: "MERGED" }));
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 0 });
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 0, woken: 0 });
    await expect(
      sc.client
        .call("git.pr.list", { threadId: thread.id, refresh: true })
        .then(() => sc.client.call("git.pr.watch", { threadId: thread.id, url })),
    ).rejects.toMatchObject({
      message: "The pull request is merged, so there is nothing to watch.",
    });

    gh.view(8, ghPullRequest({ number: 8, url: "https://github.com/acme/demo/pull/8" }));
    const closing = "https://github.com/acme/demo/pull/8";
    await sc.client.call("git.pr.watch", { threadId: thread.id, url: closing });
    gh.view(8, ghPullRequest({ number: 8, state: "CLOSED" }));
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 1 });
    await until(
      turnWith(
        (text) =>
          text ===
          `Pull request #8 (${closing}) was closed, so Jhin stopped watching it. Call git_pr_watch if it reopens.`,
      ),
    );
  });
});

describe("the watcher", () => {
  function memoryKv() {
    const data = new Map<string, unknown>();
    return {
      get: async (namespace: string, key: string) => data.get(`${namespace}/${key}`) as never,
      set: async (namespace: string, key: string, value: unknown) => {
        data.set(`${namespace}/${key}`, value);
      },
      delete: async (namespace: string, key: string) => data.delete(`${namespace}/${key}`),
      list: async (namespace: string, options: { prefix?: string } = {}) =>
        [...data]
          .filter(([key]) => key.startsWith(`${namespace}/${options.prefix ?? ""}`))
          .map(([key, value]) => ({ key: key.slice(namespace.length + 1), value: value as never })),
    };
  }

  const URL7 = "https://github.com/acme/demo/pull/7";

  async function setup() {
    const kv = memoryKv() as never;
    const sent: string[] = [];
    const thread = { archived: false, busy: false };
    let reading: ((value: unknown) => void) | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let answer: unknown = read();
    const links = createLinks({
      kv,
      append: async () => undefined,
      remoteOf: async () => null,
      read: async () => undefined,
      warn: () => undefined,
    });
    const watcher = createWatcher({
      kv,
      links,
      read: async () => {
        if (answer === "hold") {
          const held = new Promise((resolve) => (reading = resolve));
          entered();
          return held as never;
        }
        if (answer instanceof Error) throw answer;
        return answer as never;
      },
      thread: async () => thread,
      send: async (_threadId, text) => {
        sent.push(text);
      },
      warn: () => undefined,
      now: () => T0,
    });
    const { pullRequest } = await links.link("t", { url: URL7 }, "agent");
    await watcher.watch("t", pullRequest);
    return {
      links,
      watcher,
      sent,
      thread,
      answer: (value: unknown) => (answer = value),
      release: (value: unknown) => reading!(value),
      /** Resolves once the watcher is reading a held answer. */
      started,
      watching: async () => (await links.list("t"))[0]?.watch !== undefined,
    };
  }

  it("leaves a watch stopped while its pull request was read", async () => {
    const { watcher, links, answer, release, watching, started } = await setup();
    answer("hold");
    const sweep = watcher.sweep();
    // Unwatched while `gh` still answers: the sweep must not bring it back.
    await started;
    await watcher.unwatch("t", (await links.list("t"))[0]!);
    release(read({ mergeability: "conflicting" }));
    expect(await sweep).toMatchObject({ checked: 1 });
    expect(await watching()).toBe(false);
  });

  it("stops after eight failed reads in a row and says so", async () => {
    const { watcher, sent, answer, watching } = await setup();
    answer(new Error("gh is gone"));
    for (let index = 1; index < 8; index += 1) await watcher.sweep();
    expect(await watching()).toBe(true);
    expect(sent).toEqual([]);
    await watcher.sweep();
    expect(await watching()).toBe(false);
    expect(sent).toEqual([
      `Jhin stopped watching pull request #7 (${URL7}) because it failed to read it from the host 8 times in a row. Check it yourself, and call git_pr_watch to watch it again.`,
    ]);
  });

  it("ends the watch of an archived thread without waking it", async () => {
    const { watcher, sent, thread, answer, watching } = await setup();
    thread.archived = true;
    answer(read({ mergeability: "conflicting" }));
    expect(await watcher.sweep()).toEqual({ checked: 1, woken: 0 });
    expect(await watching()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("holds news during a turn and sends it once when the turn ends and a sweep runs together", async () => {
    const { watcher, sent, thread, answer } = await setup();
    thread.busy = true;
    answer(
      read({
        remarks: [{ id: "c1", author: "reviewer", body: "Hm", createdAt: later(1) }],
      }),
    );
    expect(await watcher.sweep()).toEqual({ checked: 1, woken: 1 });
    expect(sent).toEqual([]);
    thread.busy = false;
    await Promise.all([watcher.idle("t"), watcher.sweep(), watcher.idle("t")]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('- 1 new comment:\n  - reviewer: "Hm"');
  });
});
