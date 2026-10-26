// A pull request's details and actions on every forge, and GitHub's review threads in a watch
// (docs/plans/source-control.md D1447, D1449–D1451), against fake `gh`, `glab`, `az` and `tea`
// and a local Bitbucket server.
import * as Http from "node:http";

import type { PullRequest, PullRequestDetail, ThreadPullRequest } from "@jhin/source-control-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { bitbucketForge } from "../src/bitbucket.ts";
import { forgejoForge } from "../src/forgejo.ts";
import { azureForge, gitlabForge } from "../src/forges.ts";
import { githubForge } from "../src/github.ts";
import { fakeCli, fakeGh, ghPullRequest, git, node, repository, repositoryAt } from "./support.ts";

const url = "https://github.com/acme/demo/pull/7";

describe("a GitHub pull request's details (D1449, D1450)", () => {
  it("reads the author, diff stat, review decision and mergeability into the snapshot", async () => {
    const gh = fakeGh();
    gh.view(
      7,
      ghPullRequest({
        author: { login: "octo", name: "Octo Cat", is_bot: false },
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "CONFLICTING",
      }),
    );
    const pr = await githubForge(() => "gh", repository(), new Map()).at(url);
    expect(pr).toMatchObject({
      author: { login: "octo", name: "Octo Cat" },
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      reviewDecision: "changes-requested",
      mergeability: "conflicting",
    });
    expect(gh.calls()[0]).toContain(
      "author,additions,deletions,changedFiles,reviewDecision,mergeable",
    );
  });

  it("answers git.pr.detail with the checks one by one, the merge methods and the actions", async () => {
    const gh = fakeGh();
    gh.view(
      7,
      ghPullRequest({
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://ci/run/1",
          },
          {
            __typename: "StatusContext",
            context: "deploy",
            state: "PENDING",
            description: "Waiting for a runner",
            targetUrl: "https://ci/deploy",
          },
        ],
      }),
    );
    gh.required(["test"]);
    gh.repo({ mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true });
    const dir = repository();
    git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    const sc = await node();
    const projectId = await sc.project(dir);
    const detail = await sc.client.call<PullRequestDetail>("git.pr.detail", { projectId, url });
    expect(detail.pullRequest).toMatchObject({ number: 7, state: "open" });
    expect(detail.checks).toEqual([
      {
        name: "test",
        status: "failure",
        description: null,
        url: "https://ci/run/1",
        required: true,
      },
      {
        name: "deploy",
        status: "pending",
        description: "Waiting for a runner",
        url: "https://ci/deploy",
        required: false,
      },
    ]);
    expect(detail.mergeMethods).toEqual(["squash", "rebase"]);
    expect(detail.actions).toEqual(["merge", "ready", "close", "reopen"]);
    expect(gh.calls()).toContain(
      "repo view github.com/acme/demo --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
    );
    await expect(
      sc.client.call("git.pr.detail", { projectId, url: "https://example.com/nothing" }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_INVALID" });
  });
});

describe("git.pr.action (D1451)", () => {
  it("merges through gh with the chosen method and updates every thread's link", async () => {
    const gh = fakeGh();
    gh.view(7, ghPullRequest());
    const dir = repository();
    git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    const sc = await node();
    const projectId = await sc.project(dir);
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await sc.client.call("git.pr.link", { threadId: thread.id, url });
    gh.view(7, ghPullRequest({ state: "MERGED", mergedAt: "2026-10-21T10:00:00Z" }));
    const { pullRequest } = await sc.client.call<{ pullRequest: PullRequest }>("git.pr.action", {
      projectId,
      url,
      action: "merge",
      mergeMethod: "squash",
    });
    expect(pullRequest.state).toBe("merged");
    expect(gh.calls()).toContain(`pr merge ${url} --squash`);
    const { pullRequests } = await sc.client.call<{ pullRequests: ThreadPullRequest[] }>(
      "git.pr.list",
      { threadId: thread.id },
    );
    expect(pullRequests[0]?.snapshot?.state).toBe("merged");

    await sc.client.call("git.pr.action", { projectId, url, action: "ready" });
    expect(gh.calls()).toContain(`pr ready ${url}`);
  });

  it("acts only on the project's own pull requests, with a method its repository allows", async () => {
    const gh = fakeGh();
    gh.view(7, ghPullRequest());
    gh.repo({ mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false });
    const dir = repository();
    git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    const sc = await node();
    const projectId = await sc.project(dir);
    await expect(
      sc.client.call("git.pr.action", {
        projectId,
        url: "https://github.com/other/repo/pull/7",
        action: "close",
      }),
    ).rejects.toThrow(
      "https://github.com/other/repo/pull/7 is not a pull request of this project's repository or of its threads.",
    );
    await expect(
      sc.client.call("git.pr.action", { projectId, url, action: "merge", mergeMethod: "rebase" }),
    ).rejects.toThrow(
      "This repository does not allow the rebase merge method (it allows: squash).",
    );
    expect(gh.calls().some((call) => call.startsWith("pr merge"))).toBe(false);

    // Without a method asked for, "merge" is not allowed here: the first allowed one is taken.
    await sc.client.call("git.pr.action", { projectId, url, action: "merge" });
    expect(gh.calls()).toContain(`pr merge ${url} --squash`);

    // Another repository's pull request a thread of the project links is the project's too.
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    gh.view(9, ghPullRequest({ number: 9, url: "https://github.com/other/repo/pull/9" }));
    await sc.client.call("git.pr.link", {
      threadId: thread.id,
      url: "https://github.com/other/repo/pull/9",
    });
    await sc.client.call("git.pr.action", {
      projectId,
      url: "https://github.com/other/repo/pull/9",
      action: "close",
    });
    expect(gh.calls()).toContain("pr close https://github.com/other/repo/pull/9");
  });

  it("answers git.pr.detail and runs git.pr.action on GitLab, through the commands", async () => {
    const glab = fakeCli("glab");
    // Answers are tried newest first, by prefix: the project's own goes in first.
    glab.answer("api --hostname gitlab.com projects/acme%2Fdemo", {
      merge_method: "merge",
      squash_option: "default_off",
    });
    const mr = "api --hostname gitlab.com projects/acme%2Fdemo/merge_requests/5";
    glab.answer(mr, {
      iid: 5,
      title: "Add a",
      web_url: "https://gitlab.com/acme/demo/-/merge_requests/5",
      state: "opened",
      draft: true,
      source_branch: "feature",
      target_branch: "main",
      head_pipeline: { status: "failed", web_url: "https://gitlab.com/acme/demo/-/pipelines/3" },
    });
    glab.answer(`${mr}/notes`, []);
    glab.answer("api --hostname gitlab.com user", { username: "me" });
    glab.answer("mr update 5", {});
    const sc = await node();
    const projectId = await sc.project(repositoryAt("git@gitlab.com:acme/demo.git"));
    const at = "https://gitlab.com/acme/demo/-/merge_requests/5";
    const detail = await sc.client.call<PullRequestDetail>("git.pr.detail", { projectId, url: at });
    expect(detail).toMatchObject({
      pullRequest: { number: 5, isDraft: true },
      checks: [
        {
          name: "Pipeline",
          status: "failure",
          description: null,
          url: "https://gitlab.com/acme/demo/-/pipelines/3",
        },
      ],
      mergeMethods: ["merge", "squash"],
      actions: ["merge", "ready", "close", "reopen"],
    });
    await sc.client.call("git.pr.action", { projectId, url: at, action: "ready" });
    expect(glab.calls()).toContain("mr update 5 --repo https://gitlab.com/acme/demo --ready");
  });

  it("refuses an action the forge lacks, with T3's words", async () => {
    const sc = await node({ bitbucketAccessToken: "t" });
    const projectId = await sc.project(repositoryAt("git@bitbucket.org:acme/demo.git"));
    await expect(
      sc.client.call("git.pr.action", {
        projectId,
        url: "https://bitbucket.org/acme/demo/pull-requests/8",
        action: "ready",
      }),
    ).rejects.toThrow("Bitbucket does not expose ready through its API.");
  });
});

describe("the details and actions of the other forges (D1449–D1451)", () => {
  const servers: Http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  });
  const site = (host: string, path: string) => ({ cwd: repository(), host, repository: path });

  it("GitLab: the author, files count and conflict; methods from the project; glab mr actions", async () => {
    const glab = fakeCli("glab");
    // Answers are tried newest first, by prefix: the project's own goes in first.
    glab.answer("api --hostname gitlab.com projects/acme%2Fdemo", {
      merge_method: "rebase_merge",
      squash_option: "default_off",
    });
    const mr = "api --hostname gitlab.com projects/acme%2Fdemo/merge_requests/5";
    glab.answer(mr, {
      iid: 5,
      title: "Add a",
      web_url: "https://gitlab.com/acme/demo/-/merge_requests/5",
      state: "opened",
      source_branch: "feature",
      target_branch: "main",
      author: { username: "dev", name: "Dev", avatar_url: "https://gitlab.com/a.png" },
      changes_count: "4",
      has_conflicts: true,
    });
    glab.answer("mr update 5", {});
    glab.answer("mr merge 5", {});
    const forge = gitlabForge(() => "glab", site("gitlab.com", "acme/demo"), new Map());
    const at = "https://gitlab.com/acme/demo/-/merge_requests/5";
    expect(await forge.at(at)).toMatchObject({
      author: { login: "dev", name: "Dev", avatarUrl: "https://gitlab.com/a.png" },
      changedFiles: 4,
      mergeability: "conflicting",
    });
    expect(await forge.mergeMethods(at)).toEqual(["squash", "rebase"]);
    await forge.act(at, "ready", "merge");
    await forge.act(at, "merge", "rebase");
    expect(glab.calls()).toContain("mr update 5 --repo https://gitlab.com/acme/demo --ready");
    expect(glab.calls()).toContain(
      "mr merge 5 --repo https://gitlab.com/acme/demo --yes --auto-merge=false --rebase",
    );
  });

  it("Azure DevOps: the author and conflict; az repos pr update", async () => {
    const az = fakeCli("az");
    az.answer("repos pr show --id 4", {
      pullRequestId: 4,
      title: "Add a",
      status: "active",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      createdBy: { uniqueName: "dev@acme.com", displayName: "Dev" },
      mergeStatus: "conflicts",
      repository: { webUrl: "https://dev.azure.com/acme/web/_git/demo" },
    });
    az.answer("repos pr update --id 4", {});
    const forge = azureForge(() => "az", site("dev.azure.com", "acme/web/_git/demo"), new Map());
    const at = "https://dev.azure.com/acme/web/_git/demo/pullrequest/4";
    expect(await forge.at(at)).toMatchObject({
      author: { login: "dev@acme.com", name: "Dev" },
      mergeability: "conflicting",
    });
    await forge.act(at, "close", "merge");
    await forge.act(at, "merge", "squash");
    expect(az.calls()).toContainEqual(
      expect.stringMatching(
        /^repos pr update --id 4 --organization https:\/\/dev\.azure\.com\/acme --status abandoned /,
      ),
    );
    expect(az.calls()).toContainEqual(expect.stringMatching(/--status completed --squash true /));
  });

  it("Forgejo: the details from its JSON, methods from the repository, merge and close", async () => {
    const tea = fakeCli("tea");
    // Answers are tried newest first, by prefix: the repository's own goes in first.
    tea.answer("api /repos/acme/demo", { allow_merge_commits: true, allow_rebase: false });
    tea.answer("api /repos/acme/demo/pulls/2", {
      number: 2,
      title: "Add a",
      html_url: "https://codeberg.org/acme/demo/pulls/2",
      state: "open",
      user: { login: "dev", full_name: "", avatar_url: "https://codeberg.org/a.png" },
      additions: 5,
      deletions: 1,
      changed_files: 2,
      mergeable: true,
      head: { ref: "feature", repo: { full_name: "acme/demo" } },
      base: { ref: "main", repo: { full_name: "acme/demo" } },
    });
    tea.answer("api --method POST --data @- /repos/acme/demo/pulls/2/merge", null);
    tea.answer("api --method PATCH --data @- /repos/acme/demo/pulls/2", { number: 2 });
    const forge = forgejoForge(() => "tea", site("codeberg.org", "acme/demo"), new Map());
    const at = "https://codeberg.org/acme/demo/pulls/2";
    expect(await forge.at(at)).toMatchObject({
      author: { login: "dev", name: null, avatarUrl: "https://codeberg.org/a.png" },
      additions: 5,
      deletions: 1,
      changedFiles: 2,
      mergeability: "mergeable",
    });
    expect(await forge.mergeMethods(at)).toEqual(["merge", "squash"]);
    await forge.act(at, "merge", "squash");
    await forge.act(at, "close", "merge");
    expect(tea.calls()).toContain("api --method POST --data @- /repos/acme/demo/pulls/2/merge");
    expect(tea.calls()).toContain("api --method PATCH --data @- /repos/acme/demo/pulls/2");
  });

  it("Bitbucket: the diff stat summed from its diffstat, a merge strategy and a decline", async () => {
    const posted: { url: string; body: string }[] = [];
    const server = Http.createServer((request, response) => {
      const path = (request.url ?? "").replace(/^\/2\.0/, "").replace(/\?.*$/, "");
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST") posted.push({ url: path, body });
        if (path.endsWith("/diffstat")) {
          response.end(
            JSON.stringify({
              values: [
                { lines_added: 10, lines_removed: 2 },
                { lines_added: 1, lines_removed: 0 },
              ],
            }),
          );
        } else if (path.endsWith("/statuses")) {
          response.end(JSON.stringify({ values: [] }));
        } else {
          response.end(
            JSON.stringify({
              id: 8,
              title: "Add a",
              state: "OPEN",
              links: { html: { href: "https://bitbucket.org/acme/demo/pull-requests/8" } },
              source: { branch: { name: "feature" }, repository: { full_name: "acme/demo" } },
              destination: { branch: { name: "main" }, repository: { full_name: "acme/demo" } },
              author: {
                nickname: "dev",
                display_name: "Dev",
                links: { avatar: { href: "https://bitbucket.org/a.png" } },
              },
            }),
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const forge = bitbucketForge(
      site("bitbucket.org", "acme/demo"),
      () => ({ accessToken: "t", apiBaseUrl: `http://127.0.0.1:${port}/2.0` }),
      new Map(),
    );
    const at = "https://bitbucket.org/acme/demo/pull-requests/8";
    expect(await forge.at(at)).toMatchObject({
      author: { login: "dev", name: "Dev", avatarUrl: "https://bitbucket.org/a.png" },
      additions: 11,
      deletions: 2,
      changedFiles: 2,
    });
    await forge.act(at, "merge", "rebase");
    await forge.act(at, "close", "merge");
    expect(posted).toEqual([
      {
        url: "/repositories/acme/demo/pullrequests/8/merge",
        body: JSON.stringify({ merge_strategy: "rebase_fast_forward" }),
      },
      { url: "/repositories/acme/demo/pullrequests/8/decline", body: "" },
    ]);
  });
});

describe("GitHub's review threads in a watch (D1447)", () => {
  it("reads the comments of review threads with their files, once each", async () => {
    const gh = fakeGh();
    gh.view(7, ghPullRequest({ headRefOid: "abcdef1234", comments: [], reviews: [] }));
    gh.graphql({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  path: "src/a.ts",
                  comments: {
                    nodes: [
                      {
                        id: "t1",
                        author: { login: "reviewer" },
                        body: "Rename this",
                        createdAt: "2099-01-01T00:00:00Z",
                        url: "https://github.com/acme/demo/pull/7#discussion_r1",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
    const read = await githubForge(() => "gh", repository(), new Map()).watch!(url);
    expect(read.remarks).toEqual([
      {
        id: "t1",
        author: "reviewer",
        body: "Rename this",
        createdAt: "2099-01-01T00:00:00Z",
        path: "src/a.ts",
        url: "https://github.com/acme/demo/pull/7#discussion_r1",
      },
    ]);
    expect(gh.calls()).toContainEqual(
      expect.stringMatching(
        /^api graphql --hostname github\.com -F owner=acme -F name=demo -F number=7 -f query=/,
      ),
    );
  });
});
