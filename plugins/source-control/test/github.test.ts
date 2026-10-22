import type { ProjectStatus } from "@jhin/source-control-api";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { remoteHost, rollupChecks } from "../src/index.ts";
import {
  fakeGh,
  ghPullRequest,
  git,
  node,
  repository,
  statusEvent,
  threadEvent,
  write,
} from "./support.ts";

/** A repository on `feature` whose origin is on GitHub (never contacted: `gh` is fake). */
function githubRepository(branch = "feature") {
  const dir = repository();
  git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
  git(dir, "switch", "--quiet", "--create", branch);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
});

const only = (snapshot: { projects: ProjectStatus[] }) => snapshot.projects[0]!;

describe("jhin.source-control: pull requests through the GitHub CLI", () => {
  it("reads the pull request of the checked-out branch with its checks", async () => {
    const gh = fakeGh();
    gh.pullRequest("feature", [
      ghPullRequest({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
          { __typename: "StatusContext", context: "ci/deploy", state: "SUCCESS" },
        ],
      }),
    ]);
    const dir = githubRepository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const status = only(await sc.status(projectId, true));
    expect(status.provider).toEqual({ kind: "github", available: true });
    expect(status.pullRequests).toEqual({
      feature: {
        number: 7,
        title: "Add the thing",
        url: "https://github.com/acme/demo/pull/7",
        state: "open",
        isDraft: false,
        headBranch: "feature",
        baseBranch: "main",
        updatedAt: "2026-10-19T10:00:00Z",
        checks: { state: "pending", passed: 2, failed: 0, pending: 1, total: 3 },
      },
    });
    expect(gh.calls()).toContain(
      "pr list --head feature --state all --limit 10 --json number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergedAt,closedAt,statusCheckRollup,isCrossRepository,headRepositoryOwner",
    );
  });

  it.each([
    ["merged", { state: "MERGED" }, { state: "merged", isDraft: false }],
    ["closed", { state: "CLOSED" }, { state: "closed", isDraft: false }],
    ["draft", { state: "OPEN", isDraft: true }, { state: "open", isDraft: true }],
  ])("reports a %s pull request", async (_name, fields, expected) => {
    const gh = fakeGh();
    gh.pullRequest("feature", [ghPullRequest(fields)]);
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    expect(only(await sc.status(projectId, true)).pullRequests["feature"]).toMatchObject(expected);
  });

  it("says a branch has no pull request, and asks nothing for the default branch", async () => {
    const gh = fakeGh();
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    expect(only(await sc.status(projectId, true)).pullRequests).toEqual({ feature: null });
    expect(gh.calls().every((call) => call.startsWith("pr list --head feature "))).toBe(true);
  });

  it("looks up the pull request of every thread's branch, published on the stream", async () => {
    const gh = fakeGh();
    gh.pullRequest("feature", [ghPullRequest()]);
    gh.pullRequest("other", [ghPullRequest({ number: 9, headRefName: "other", state: "MERGED" })]);
    const dir = githubRepository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await sc.until(threadEvent(thread.id, (record) => record.branch === "feature"));
    // The thread stays on feature while the checkout moves to other.
    git(dir, "switch", "--quiet", "--create", "other");
    const event = await sc.until(
      statusEvent(
        projectId,
        (status) =>
          status.branch === "other" &&
          status.pullRequests["other"]?.number === 9 &&
          status.pullRequests["feature"]?.number === 7,
      ),
    );
    expect((event.payload as ProjectStatus).pullRequests["other"]).toMatchObject({
      state: "merged",
    });
    expect(await sc.client.call("git.thread.status", { threadId: thread.id })).toMatchObject({
      checkedOut: false,
      pullRequest: { number: 7, state: "open" },
    });
  });

  it("settles a thread when its branch's pull request merges (D447)", async () => {
    const gh = fakeGh();
    gh.pullRequest("feature", [ghPullRequest()]);
    const dir = githubRepository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await sc.until(threadEvent(thread.id, (record) => record.branch === "feature"));
    await sc.client.call("git.status", { refresh: true });
    const get = async () =>
      (
        await sc.client.call<{ thread: { settledOverride?: string } }>("threads.get", {
          threadId: thread.id,
        })
      ).thread;
    // Open: nothing to settle on.
    expect((await get()).settledOverride).toBeUndefined();

    const closedAt = new Date(Date.now() + 60_000).toISOString();
    gh.pullRequest("feature", [ghPullRequest({ state: "MERGED", closedAt })]);
    const settled = sc.next("threads", (event) => {
      const record = event.payload as { id?: string; settledOverride?: string };
      return record.id === thread.id && record.settledOverride === "settled";
    });
    await sc.client.call("git.status", { refresh: true });
    await settled;
    expect((await get()).settledOverride).toBe("settled");
  });

  it("takes gh's zero time on an open pull request for no close time", async () => {
    const gh = fakeGh();
    gh.pullRequest("feature", [ghPullRequest({ closedAt: "0001-01-01T00:00:00Z" })]);
    const dir = githubRepository();
    const sc = await node();
    const projectId = await sc.project(dir);
    const status = await sc.status(projectId, true);
    expect(only(status).pullRequests["feature"]).toMatchObject({ state: "open" });
    expect(only(status).pullRequests["feature"]?.closedAt).toBeUndefined();
  });

  it("degrades without gh: pull requests stay unknown and the reason is given", async () => {
    const sc = await node({ ghPath: "jhin-no-such-gh" });
    const projectId = await sc.project(githubRepository());
    expect(only(await sc.status(projectId, true))).toMatchObject({
      branch: "feature",
      provider: {
        kind: "github",
        available: false,
        reason: "GitHub CLI (gh) is not installed on this node",
      },
      pullRequests: {},
    });
  });

  it("degrades when gh is signed out", async () => {
    const gh = fakeGh();
    gh.fail(4, "To get started with GitHub CLI, please run:  gh auth login\n");
    const sc = await node();
    const projectId = await sc.project(githubRepository());
    expect(only(await sc.status(projectId, true))).toMatchObject({
      provider: {
        available: false,
        reason: "GitHub CLI is not signed in: run `gh auth login` on this node",
      },
      pullRequests: {},
    });
  });

  it("asks gh again once its refresh period has passed, without a forced refresh", async () => {
    const gh = fakeGh();
    gh.pullRequest("feature", [ghPullRequest()]);
    gh.fail(4, "To get started with GitHub CLI, please run:  gh auth login\n");
    const dir = githubRepository();
    const sc = await node({ pullRequestRefreshSeconds: 60 });
    const projectId = await sc.project(dir);
    expect(only(await sc.status(projectId, true)).provider?.available).toBe(false);
    // Signed in meanwhile; a minute later the next change of the tree asks gh again.
    gh.recover();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    write(dir, "notes.md", "x\n");
    await sc.until(
      statusEvent(
        projectId,
        (status) =>
          status.provider?.available === true && status.pullRequests["feature"]?.number === 7,
      ),
    );
  });

  it("asks no forge about a host that is none", async () => {
    const gh = fakeGh();
    const dir = repository();
    git(dir, "remote", "add", "origin", "git@git.example.com:acme/demo.git");
    git(dir, "switch", "--quiet", "--create", "feature");
    const sc = await node();
    const projectId = await sc.project(dir);
    expect(only(await sc.status(projectId, true))).toMatchObject({
      provider: null,
      pullRequests: {},
    });
    expect(gh.calls()).toEqual([]);
  });
});

describe("jhin.source-control: reading GitHub's answers", () => {
  it("finds the host of https, ssh and scp-like remotes", () => {
    expect(remoteHost("https://github.com/acme/demo.git")).toBe("github.com");
    expect(remoteHost("ssh://git@GitHub.com/acme/demo.git")).toBe("github.com");
    expect(remoteHost("git@github.com:acme/demo.git")).toBe("github.com");
    expect(remoteHost("/srv/git/demo.git")).toBeUndefined();
  });

  it("rolls checks up as T3 Code does", () => {
    expect(rollupChecks([])).toEqual({ state: null, passed: 0, failed: 0, pending: 0, total: 0 });
    expect(
      rollupChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toMatchObject({ state: "passing", passed: 1, total: 2 });
    expect(
      rollupChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "QUEUED" },
        { state: "FAILURE" },
      ]),
    ).toMatchObject({ state: "failing", passed: 1, pending: 1, failed: 1 });
    expect(rollupChecks([{ status: "COMPLETED", conclusion: "NEUTRAL" }])).toMatchObject({
      state: null,
      total: 1,
    });
  });
});
