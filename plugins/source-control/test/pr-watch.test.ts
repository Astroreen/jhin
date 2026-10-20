import type { PullRequestWatch, ThreadPullRequest } from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { evaluateWatch, startWatch, watchMessage } from "../src/index.ts";
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
    expect(gh.calls()).toContain("api user");
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
