import type { ThreadPullRequest } from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { fakeGh, ghPullRequest, git, node, repository, temp } from "./support.ts";

/** A repository on `feature` whose origin is GitHub. */
function githubRepository() {
  const dir = repository();
  const remote = temp("jhin-sc-remote-");
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
  git(dir, "config", "remote.origin.pushurl", remote);
  git(dir, "push", "--quiet", remote, "main:main");
  git(dir, "switch", "--quiet", "--create", "feature");
  return dir;
}

const read = (threadId: string, number: number) => (event: StoredEvent) =>
  event.type === "git.pr.updated" &&
  (event.payload as { threadId: string; pullRequest: ThreadPullRequest }).threadId === threadId &&
  (event.payload as { pullRequest: ThreadPullRequest }).pullRequest.number === number &&
  (event.payload as { pullRequest: ThreadPullRequest }).pullRequest.snapshot !== null;

const settled = (threadId: string) => (event: StoredEvent) =>
  event.type === "threads.thread.updated" &&
  (event.payload as { id: string; settledAt?: string }).id === threadId &&
  (event.payload as { settledAt?: string }).settledAt !== undefined;

const url = (number: number) => `https://github.com/acme/demo/pull/${number}`;
const merged = (number: number, mergedAt: string) =>
  ghPullRequest({
    number,
    url: url(number),
    state: "MERGED",
    mergedAt,
    headRefName: `pr-${number}`,
  });

describe("jhin.source-control: settling a thread on its linked pull requests (D1133)", () => {
  it("settles once every link merged or closed, but not on a link made after it merged", async () => {
    const gh = fakeGh();
    gh.view(7, merged(7, "2099-01-01T00:00:00Z"));
    gh.view(8, merged(8, "2001-01-01T00:00:00Z"));
    gh.view(10, ghPullRequest({ number: 10, url: url(10), state: "OPEN", headRefName: "pr-10" }));
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    const create = async () =>
      (await sc.client.call<{ id: string }>("threads.create", { projectId })).id;

    // An open link holds the thread, whatever another one did: the node says so.
    const held = await create();
    // Waited on from the start: the hold is told once, whichever read decides it first.
    const holding = sc.logged("a thread waits on its open linked pull requests");
    await sc.client.call("git.pr.link", { threadId: held, url: url(10) });
    await sc.until(read(held, 10));
    await sc.client.call("git.pr.link", { threadId: held, url: url(7) });
    await holding;

    // A link made after its pull request merged records work done, not what the thread waits on.
    const recorded = await create();
    const leftOut = sc.logged("no linked pull request settles the thread");
    await sc.client.call("git.pr.link", { threadId: recorded, url: url(8) });
    await leftOut;

    // The thread's only link merged after it was linked: it settles.
    const done = await create();
    const settling = sc.next("threads", settled(done));
    await sc.client.call("git.pr.link", { threadId: done, url: url(7) });
    await settling;

    // Decided before the last thread settled, the other two stayed as they were.
    const threads = await sc.client.call<{ id: string; settledAt?: string }[]>("threads.list", {
      projectId,
    });
    expect(
      Object.fromEntries(threads.map((thread) => [thread.id, thread.settledAt !== undefined])),
    ).toEqual({ [held]: false, [recorded]: false, [done]: true });

    // Unlinking the open one lets the merged link settle the held thread.
    const freed = sc.next("threads", settled(held));
    await sc.client.call("git.pr.unlink", { threadId: held, url: url(10) });
    await freed;
  });

  it("settles on the latest of several closed links", async () => {
    const gh = fakeGh();
    gh.view(7, merged(7, "2099-01-01T00:00:00Z"));
    gh.view(
      11,
      ghPullRequest({
        number: 11,
        url: url(11),
        state: "CLOSED",
        closedAt: "2099-02-01T00:00:00Z",
        headRefName: "pr-11",
      }),
    );
    // A merge settles nothing under this rule; a close always does. So only the later,
    // closed link settling the thread shows that the latest of them decided.
    const sc = await node({}, { threads: { autoSettleOnMerge: false } });
    const projectId = await sc.project(githubRepository());
    const several = (await sc.client.call<{ id: string }>("threads.create", { projectId })).id;
    await sc.client.call("git.pr.link", { threadId: several, url: url(7) });
    await sc.until(read(several, 7));
    const settling = sc.next("threads", settled(several));
    await sc.client.call("git.pr.link", { threadId: several, url: url(11) });
    await settling;
  });

  it("holds a branch's merged pull request for an open link", async () => {
    const gh = fakeGh();
    gh.view(10, ghPullRequest({ number: 10, url: url(10), state: "OPEN", headRefName: "pr-10" }));
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    // On the branch `feature`, whose own pull request merged: an open link still holds it.
    const onBranch = (await sc.client.call<{ id: string }>("threads.create", { projectId })).id;
    // Waited on from the start: the hold is told once, whichever read decides it first.
    const holding = sc.logged("a thread waits on its open linked pull requests");
    await sc.client.call("git.pr.link", { threadId: onBranch, url: url(10) });
    await sc.until(read(onBranch, 10));
    gh.pullRequest("feature", [
      ghPullRequest({ number: 12, state: "MERGED", mergedAt: "2099-03-01T00:00:00Z" }),
    ]);
    await sc.status(projectId, true);
    await holding;
    const [thread] = (
      await sc.client.call<{ id: string; settledAt?: string }[]>("threads.list", { projectId })
    ).filter((item) => item.id === onBranch);
    expect(thread?.settledAt).toBeUndefined();

    // Unlinking the open link lets the branch's merged pull request settle it at once.
    const freed = sc.next("threads", settled(onBranch));
    await sc.client.call("git.pr.unlink", { threadId: onBranch, url: url(10) });
    await freed;
  });

  it("settles a thread when its open link merges, read again", async () => {
    const gh = fakeGh();
    gh.view(13, ghPullRequest({ number: 13, url: url(13), state: "OPEN", headRefName: "pr-13" }));
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    const threadId = (await sc.client.call<{ id: string }>("threads.create", { projectId })).id;
    await sc.client.call("git.pr.link", { threadId, url: url(13) });
    await sc.until(read(threadId, 13));

    gh.view(13, merged(13, "2099-04-01T00:00:00Z"));
    const settling = sc.next("threads", settled(threadId));
    await sc.client.call("git.pr.list", { threadId, refresh: true });
    await settling;
  });

  it("is not held by a link on a host no forge of the node reads", async () => {
    const gh = fakeGh();
    gh.view(7, merged(7, "2099-01-01T00:00:00Z"));
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    const threadId = (await sc.client.call<{ id: string }>("threads.create", { projectId })).id;
    // Never read, and nothing here could read it: it tells nothing, so it holds nothing.
    await sc.client.call("git.pr.link", {
      threadId,
      url: "https://forge.example.com/acme/demo/pull/5",
    });
    const settling = sc.next("threads", settled(threadId));
    await sc.client.call("git.pr.link", { threadId, url: url(7) });
    await settling;
  });

  it("falls back to its branch's pull request when every link is left out", async () => {
    const gh = fakeGh();
    gh.view(8, merged(8, "2001-01-01T00:00:00Z"));
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    const threadId = (await sc.client.call<{ id: string }>("threads.create", { projectId })).id;
    // Merged before it was linked: left out, so it neither holds nor settles the thread.
    const leftOut = sc.logged("no linked pull request settles the thread");
    await sc.client.call("git.pr.link", { threadId, url: url(8) });
    await leftOut;
    // The branch's own pull request merges: it decides, as without links.
    const settling = sc.next("threads", settled(threadId));
    gh.pullRequest("feature", [
      ghPullRequest({ number: 14, state: "MERGED", mergedAt: "2099-05-01T00:00:00Z" }),
    ]);
    await sc.status(projectId, true);
    await settling;
  });
});
