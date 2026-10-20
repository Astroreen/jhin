import type { StoredEvent } from "@jhin/storage-api";
import {
  parsePullRequestUrl,
  pullRequestChains,
  repositoryOfRemote,
  type GitActionResult,
  type StatusSnapshot,
  type ThreadPullRequest,
} from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestUrl } from "../src/index.ts";
import { fakeGh, ghPullRequest, git, node, repository, temp, write } from "./support.ts";

interface Listed {
  pullRequests: ThreadPullRequest[];
  chains: { numbers: number[]; keys: string[] }[];
}

/** A repository on `feature` whose origin is GitHub, pushing to a bare repository. */
function githubRepository() {
  const dir = repository();
  const remote = temp("jhin-sc-remote-");
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
  git(dir, "config", "remote.origin.pushurl", remote);
  git(dir, "push", "--quiet", remote, "main:main");
  git(dir, "fetch", "--quiet", remote, "+refs/heads/*:refs/remotes/origin/*");
  git(dir, "switch", "--quiet", "--create", "feature");
  return dir;
}

const linkedTo = (threadId: string) => (event: StoredEvent) =>
  event.type === "git.pr.linked" && (event.payload as { threadId: string }).threadId === threadId;
const updated = (threadId: string, state: string) => (event: StoredEvent) =>
  event.type === "git.pr.updated" &&
  (event.payload as { threadId: string; pullRequest: ThreadPullRequest }).threadId === threadId &&
  (event.payload as { pullRequest: ThreadPullRequest }).pullRequest.snapshot?.state === state;

describe("jhin.source-control: pull requests linked to threads", () => {
  it("links a pull request by URL, reads its state, lists and unlinks it", async () => {
    const gh = fakeGh();
    gh.view(7, ghPullRequest({ state: "OPEN" }));
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    const url = "https://github.com/acme/demo/pull/7";
    const first = await sc.client.call<{ pullRequest: ThreadPullRequest; alreadyLinked: boolean }>(
      "git.pr.link",
      { threadId: thread.id, url },
    );
    expect(first).toMatchObject({
      alreadyLinked: false,
      pullRequest: {
        key: "github.com/acme/demo#7",
        host: "github.com",
        repository: "acme/demo",
        number: 7,
        url,
        source: "agent",
        snapshot: null,
      },
    });
    await sc.until(linkedTo(thread.id));
    const read = await sc.until(updated(thread.id, "open"));
    expect((read.payload as { pullRequest: ThreadPullRequest }).pullRequest.snapshot).toMatchObject(
      {
        number: 7,
        title: "Add the thing",
      },
    );
    expect(gh.calls()).toContainEqual(
      expect.stringMatching(/^pr view https:\/\/github.com\/acme\/demo\/pull\/7 --json /),
    );

    // Linking it again, by repository and number on the project's host, changes nothing.
    expect(
      await sc.client.call("git.pr.link", {
        threadId: thread.id,
        repository: "acme/demo",
        number: 7,
        source: "manual",
      }),
    ).toMatchObject({ alreadyLinked: true, pullRequest: { source: "agent" } });

    const listed = await sc.client.call<Listed>("git.pr.list", { threadId: thread.id });
    expect(listed.pullRequests.map((link) => link.number)).toEqual([7]);
    expect(listed.chains).toEqual([{ keys: ["github.com/acme/demo#7"], numbers: [7] }]);
    const snapshot = await sc.status();
    expect(snapshot.links).toEqual([{ threadId: thread.id, pullRequests: listed.pullRequests }]);

    expect(await sc.client.call("git.pr.unlink", { threadId: thread.id, url })).toEqual({
      key: "github.com/acme/demo#7",
      wasLinked: true,
    });
    await sc.until((event) => event.type === "git.pr.unlinked");
    expect(await sc.client.call("git.pr.unlink", { threadId: thread.id, url })).toMatchObject({
      wasLinked: false,
    });
    expect((await sc.status()).links).toEqual([]);
  });

  it("says what it needs to name a pull request", async () => {
    const sc = await node();
    const projectId = await sc.project(repository());
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await expect(
      sc.client.call("git.pr.link", { threadId: thread.id, url: "https://example.com/nope" }),
    ).rejects.toMatchObject({
      code: "PULL_REQUEST_INVALID",
      message: "This is not a recognised pull request URL. Pass repository and number instead.",
    });
    await expect(
      sc.client.call("git.pr.link", { threadId: thread.id, number: 3 }),
    ).rejects.toMatchObject({ message: "Pass either url, or both repository and number." });
    await expect(
      sc.client.call("git.pr.link", { threadId: thread.id, repository: "acme/demo", number: 3 }),
    ).rejects.toMatchObject({
      message: "This thread's project has no recognised remote. Pass host or url.",
    });
    await expect(
      sc.client.call("git.pr.link", { threadId: "nope", repository: "a/b", number: 1, host: "x" }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("links the pull request a git action creates to its thread, and forgets links with the thread", async () => {
    fakeGh();
    const dir = githubRepository();
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      threadId: thread.id,
      action: "commit_push_pr",
      commitMessage: "Add a",
    });
    expect(result.pr.status).toBe("created");
    const listed = await sc.client.call<Listed>("git.pr.list", { threadId: thread.id });
    expect(listed.pullRequests).toEqual([
      expect.objectContaining({
        key: "github.com/acme/demo#42",
        source: "created",
        snapshot: expect.objectContaining({ number: 42, state: "open", headBranch: "feature" }),
      }),
    ]);
    await sc.client.call("threads.delete", { threadId: thread.id });
    await sc.until((event) => event.type === "source-control.thread.removed");
    expect((await sc.client.call<StatusSnapshot>("git.status", {})).links).toEqual([]);
  });
});

describe("linked pull request helpers", () => {
  it("reads pull request URLs of every forge", () => {
    expect(parsePullRequestUrl("https://github.com/acme/demo/pull/7/files")).toEqual({
      host: "github.com",
      repository: "acme/demo",
      number: 7,
    });
    expect(parsePullRequestUrl("https://gitlab.com/g/sub/demo/-/merge_requests/3")).toEqual({
      host: "gitlab.com",
      repository: "g/sub/demo",
      number: 3,
    });
    expect(parsePullRequestUrl("https://bitbucket.org/ws/demo/pull-requests/9")?.number).toBe(9);
    expect(parsePullRequestUrl("https://codeberg.org/o/demo/pulls/2")?.repository).toBe("o/demo");
    expect(
      parsePullRequestUrl("https://dev.azure.com/org/proj/_git/demo/pullrequest/5")?.repository,
    ).toBe("org/proj/_git/demo");
    expect(parsePullRequestUrl("https://user:pw@github.com/a/b/pull/1")).toBeUndefined();
    expect(parsePullRequestUrl("#42")).toBeUndefined();
    expect(repositoryOfRemote("git@github.com:acme/demo.git")).toEqual({
      host: "github.com",
      repository: "acme/demo",
    });
    expect(pullRequestUrl({ host: "gitlab.com", repository: "g/demo", number: 3 })).toBe(
      "https://gitlab.com/g/demo/-/merge_requests/3",
    );
  });

  it("chains pull requests by base branch, newest chain first, ambiguous heads alone", () => {
    const link = (number: number, head: string, base: string, updatedAt: string) =>
      ({
        key: `github.com/acme/demo#${number}`,
        host: "github.com",
        repository: "acme/demo",
        number,
        url: "",
        source: "created",
        linkedAt: "2026-10-01T00:00:00Z",
        snapshot: { headBranch: head, baseBranch: base, updatedAt },
      }) as unknown as ThreadPullRequest;
    const keys = (chains: { keys: readonly string[] }[]) =>
      chains.map((chain) => chain.keys.map((key) => Number(key.split("#")[1])));
    expect(
      keys(
        pullRequestChains([
          link(1, "a", "main", "2026-10-02"),
          link(2, "b", "a", "2026-10-03"),
          link(3, "c", "b", "2026-10-01"),
          link(4, "x", "main", "2026-10-09"),
        ]),
      ),
    ).toEqual([[4], [1, 2, 3]]);
    // Two pull requests with head `a`: neither is anyone's parent.
    expect(
      keys(
        pullRequestChains([
          link(1, "a", "main", "2026-10-01"),
          link(2, "a", "main", "2026-10-02"),
          link(3, "c", "a", "2026-10-03"),
        ]),
      ),
    ).toEqual([[3], [2], [1]]);
  });
});
