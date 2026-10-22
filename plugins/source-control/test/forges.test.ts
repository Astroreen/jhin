import * as Http from "node:http";

import type { GitActionResult, ProjectStatus } from "@jhin/source-control-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { forgeKindOf, matchesHead } from "../src/index.ts";
import { fakeCli, fakeGh, ghPullRequest, git, node, repository, temp, write } from "./support.ts";

const only = (snapshot: { projects: ProjectStatus[] }) => snapshot.projects[0]!;

/** A repository on `feature` whose `origin` is `url`, pushing to a bare repository. */
function repositoryAt(url: string) {
  const dir = repository();
  const remote = temp("jhin-sc-remote-");
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(dir, "remote", "add", "origin", url);
  git(dir, "config", "remote.origin.pushurl", remote);
  git(dir, "push", "--quiet", remote, "main:main");
  git(dir, "fetch", "--quiet", remote, "+refs/heads/*:refs/remotes/origin/*");
  git(dir, "switch", "--quiet", "--create", "feature");
  return dir;
}

describe("which forge a host is", () => {
  it("tells forges apart by their hosts, as T3 Code does, and takes configured ones first", () => {
    expect(forgeKindOf("github.com")).toBe("github");
    expect(forgeKindOf("acme.ghe.com")).toBe("github");
    expect(forgeKindOf("github.acme.internal")).toBe("github");
    expect(forgeKindOf("gitlab.com")).toBe("gitlab");
    expect(forgeKindOf("gitlab.acme.io:8443")).toBe("gitlab");
    expect(forgeKindOf("dev.azure.com")).toBe("azure-devops");
    expect(forgeKindOf("acme.visualstudio.com")).toBe("azure-devops");
    expect(forgeKindOf("bitbucket.org")).toBe("bitbucket");
    expect(forgeKindOf("codeberg.org")).toBe("forgejo");
    expect(forgeKindOf("gitea.acme.io")).toBe("forgejo");
    expect(forgeKindOf("git.acme.io")).toBeUndefined();
    expect(forgeKindOf("git.acme.io", { "GIT.acme.io": "gitlab" })).toBe("gitlab");
  });

  it("matches a branch's pull request to its repository or its fork", () => {
    const pr = { headBranch: "main" } as never;
    expect(matchesHead({ pr, crossRepository: false }, { branch: "main" })).toBe(true);
    expect(matchesHead({ pr, crossRepository: true, headOwner: "x" }, { branch: "main" })).toBe(
      false,
    );
    expect(
      matchesHead({ pr, crossRepository: true, headOwner: "Me" }, { branch: "main", owner: "me" }),
    ).toBe(true);
    expect(matchesHead({ pr, crossRepository: false }, { branch: "main", owner: "me" })).toBe(
      false,
    );
  });
});

describe("jhin.source-control: GitHub Enterprise and forks", () => {
  it("reads pull requests of a GitHub Enterprise host", async () => {
    const gh = fakeGh();
    gh.pullRequest("feature", [ghPullRequest({ url: "https://github.acme.io/acme/demo/pull/7" })]);
    const sc = await node();
    const projectId = await sc.project(repositoryAt("https://github.acme.io/acme/demo.git"));
    const status = only(await sc.status(projectId, true));
    expect(status.provider).toEqual({ kind: "github", available: true });
    expect(status.pullRequests["feature"]?.number).toBe(7);
  });

  it("tells a fork's pull request from a same-named branch of another fork", async () => {
    const gh = fakeGh();
    const theirs = ghPullRequest({
      number: 3,
      isCrossRepository: true,
      headRepositoryOwner: { login: "someone" },
    });
    const mine = ghPullRequest({
      number: 4,
      isCrossRepository: true,
      headRepositoryOwner: { login: "me" },
    });
    gh.pullRequest("feature", [theirs, mine]);
    // Cloned from the fork: `origin` is mine, `upstream` the repository pull requests go to.
    const dir = repositoryAt("https://github.com/me/demo.git");
    git(dir, "remote", "add", "upstream", "https://github.com/acme/demo.git");
    const sc = await node();
    const projectId = await sc.project(dir);
    expect(only(await sc.status(projectId, true)).pullRequests["feature"]?.number).toBe(4);

    // Not pushed to a fork: no fork's pull request is the branch's.
    const plain = repositoryAt("https://github.com/acme/demo.git");
    const other = await sc.project(plain);
    expect(only(await sc.status(other, true)).pullRequests["feature"]).toBeNull();
  });

  it("opens a fork's pull request with its owner in the head", async () => {
    const gh = fakeGh();
    const dir = repositoryAt("https://github.com/me/demo.git");
    git(dir, "remote", "add", "upstream", "https://github.com/acme/demo.git");
    git(
      dir,
      "fetch",
      "--quiet",
      git(dir, "config", "remote.origin.pushurl").trim(),
      "+refs/heads/*:refs/remotes/upstream/*",
    );
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    await sc.client.call("git.action.run", {
      projectId,
      action: "commit_push_pr",
      commitMessage: "Add a",
    });
    expect(gh.calls()).toContainEqual(
      expect.stringContaining("pr create --base main --head me:feature"),
    );
  });
});

describe("jhin.source-control: GitLab through glab", () => {
  const mr = (fields: Record<string, unknown> = {}) => ({
    iid: 5,
    title: "Add a",
    web_url: "https://gitlab.com/acme/demo/-/merge_requests/5",
    state: "opened",
    draft: false,
    source_branch: "feature",
    target_branch: "main",
    updated_at: "2026-10-20T10:00:00Z",
    source_project_id: 1,
    target_project_id: 1,
    head_pipeline: { status: "failed" },
    ...fields,
  });

  it("reads a branch's merge request with its pipeline, and creates one", async () => {
    const glab = fakeCli("glab");
    glab.answer("mr list --repo https://gitlab.com/acme/demo --source-branch feature", [
      mr({ iid: 9, source_project_id: 2, updated_at: "2026-10-21T00:00:00Z" }),
      mr(),
    ]);
    const dir = repositoryAt("git@gitlab.com:acme/demo.git");
    const sc = await node();
    const projectId = await sc.project(dir);
    const status = only(await sc.status(projectId, true));
    expect(status.provider).toEqual({ kind: "gitlab", available: true });
    // The newer one comes from a fork: not this branch's.
    expect(status.pullRequests["feature"]).toMatchObject({
      number: 5,
      url: "https://gitlab.com/acme/demo/-/merge_requests/5",
      state: "open",
      checks: { state: "failing", failed: 1, total: 1 },
    });

    glab.answer("mr list --repo https://gitlab.com/acme/demo --source-branch topic", []);
    glab.answer(
      "api --hostname gitlab.com --method POST projects/acme%2Fdemo/merge_requests",
      mr({
        iid: 6,
        source_branch: "topic",
        web_url: "https://gitlab.com/acme/demo/-/merge_requests/6",
      }),
    );
    git(dir, "switch", "--quiet", "--create", "topic");
    write(dir, "a.txt", "a\n");
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit_push_pr",
      commitMessage: "Add a",
    });
    expect(result.toast).toMatchObject({
      title: "Created MR #6",
      cta: { kind: "open_pr", label: "View MR" },
    });
    expect(glab.calls()).toContainEqual(
      expect.stringMatching(
        /^api --hostname gitlab.com --method POST projects\/acme%2Fdemo\/merge_requests --raw-field source_branch=topic --raw-field target_branch=main --raw-field title=Add a --field description=@/,
      ),
    );
  });

  it("does not offer to watch a merge request yet", async () => {
    fakeCli("glab");
    const sc = await node();
    const projectId = await sc.project(repositoryAt("git@gitlab.com:acme/demo.git"));
    const thread = await sc.client.call<{ id: string }>("threads.create", { projectId });
    await expect(
      sc.client.call("git.pr.watch", {
        threadId: thread.id,
        url: "https://gitlab.com/acme/demo/-/merge_requests/5",
      }),
    ).rejects.toMatchObject({
      code: "ACTION_UNAVAILABLE",
      message: "Watching pull requests on GitLab is not supported on this node yet.",
    });
  });

  it("says when glab is missing", async () => {
    const sc = await node({ glabPath: "/nonexistent/glab" });
    const projectId = await sc.project(repositoryAt("git@gitlab.com:acme/demo.git"));
    expect(only(await sc.status(projectId, true)).provider).toEqual({
      kind: "gitlab",
      available: false,
      reason: "GitLab CLI (glab) is not installed on this node",
    });
  });
});

describe("jhin.source-control: Azure DevOps through az", () => {
  it("reads a branch's pull request", async () => {
    const az = fakeCli("az");
    az.answer(
      "repos pr list --organization https://dev.azure.com/acme --project web --repository demo --source-branch feature",
      [
        {
          pullRequestId: 12,
          title: "Add a",
          status: "completed",
          isDraft: false,
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          creationDate: "2026-10-19T10:00:00Z",
          closedDate: "2026-10-20T10:00:00Z",
          repository: { webUrl: "https://dev.azure.com/acme/web/_git/demo" },
          forkSource: null,
        },
      ],
    );
    const sc = await node();
    const projectId = await sc.project(repositoryAt("https://dev.azure.com/acme/web/_git/demo"));
    expect(only(await sc.status(projectId, true)).pullRequests["feature"]).toMatchObject({
      number: 12,
      url: "https://dev.azure.com/acme/web/_git/demo/pullrequest/12",
      state: "merged",
      mergedAt: "2026-10-20T10:00:00Z",
      checks: { state: null },
    });
  });
});

describe("jhin.source-control: creating on Azure DevOps, and refusing forks where unsupported", () => {
  it("creates an Azure DevOps pull request in the remote's repository", async () => {
    const az = fakeCli("az");
    const where = "--organization https://dev.azure.com/acme --project web --repository demo";
    az.answer(`repos pr list ${where} --source-branch feature`, []);
    az.answer(`repos pr create ${where} --source-branch feature --target-branch main`, {
      pullRequestId: 13,
      title: "Add a",
      status: "active",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      creationDate: "2026-10-21T10:00:00Z",
      repository: { webUrl: "https://dev.azure.com/acme/web/_git/demo" },
      forkSource: null,
    });
    const dir = repositoryAt("https://dev.azure.com/acme/web/_git/demo");
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    const result = await sc.client.call<GitActionResult>("git.action.run", {
      projectId,
      action: "commit_push_pr",
      commitMessage: "Add a",
    });
    expect(result.toast.title).toBe("Created PR #13");
    expect(az.calls()).toContainEqual(
      expect.stringContaining(
        `repos pr create ${where} --source-branch feature --target-branch main --title Add a --description ## Summary`,
      ),
    );
  });

  it("refuses a GitLab merge request from a fork instead of opening one from the wrong project", async () => {
    const glab = fakeCli("glab");
    glab.answer("mr list --repo https://gitlab.com/acme/demo --source-branch feature", []);
    const dir = repositoryAt("git@gitlab.com:me/demo.git");
    git(dir, "remote", "add", "upstream", "git@gitlab.com:acme/demo.git");
    write(dir, "a.txt", "a\n");
    const sc = await node();
    const projectId = await sc.project(dir);
    await expect(
      sc.client.call("git.action.run", { projectId, action: "commit_push_pr", commitMessage: "A" }),
    ).rejects.toMatchObject({
      code: "PULL_REQUEST_FAILED",
      message: "Opening a GitLab merge request from a fork is not supported on this node yet",
    });
  });
});

describe("jhin.source-control: Forgejo and Gitea through tea", () => {
  it("reads a branch's pull request with its commit statuses", async () => {
    const tea = fakeCli("tea");
    tea.answer("api /repos/acme/demo/pulls?state=all", [
      {
        number: 2,
        title: "WIP: Add a",
        html_url: "https://codeberg.org/acme/demo/pulls/2",
        state: "open",
        merged: false,
        head: {
          ref: "feature",
          sha: "abc",
          repo: { full_name: "acme/demo", owner: { login: "acme" } },
        },
        base: { ref: "main", repo: { full_name: "acme/demo" } },
        updated_at: "2026-10-20T10:00:00Z",
      },
    ]);
    tea.answer("api /repos/acme/demo/commits/abc/status", {
      statuses: [{ status: "success" }, { status: "pending" }],
    });
    const sc = await node();
    const projectId = await sc.project(repositoryAt("https://codeberg.org/acme/demo.git"));
    expect(only(await sc.status(projectId, true)).pullRequests["feature"]).toMatchObject({
      number: 2,
      isDraft: true,
      checks: { state: "pending", passed: 1, pending: 1 },
    });
  });
});

describe("jhin.source-control: Bitbucket through its API", () => {
  const servers: Http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    for (const key of ["JHIN_BITBUCKET_API_BASE_URL", "JHIN_BITBUCKET_ACCESS_TOKEN"]) {
      delete process.env[key];
    }
  });

  it("reads a branch's pull request and its statuses with the node's token", async () => {
    const seen: { url: string; authorization: string | undefined }[] = [];
    const server = Http.createServer((request, response) => {
      seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("/statuses")) {
        response.end(JSON.stringify({ values: [{ state: "SUCCESSFUL" }] }));
        return;
      }
      response.end(
        JSON.stringify({
          values: [
            {
              id: 8,
              title: "Add a",
              state: "OPEN",
              links: { html: { href: "https://bitbucket.org/acme/demo/pull-requests/8" } },
              source: { branch: { name: "feature" }, repository: { full_name: "acme/demo" } },
              destination: { branch: { name: "main" }, repository: { full_name: "acme/demo" } },
              updated_on: "2026-10-20T10:00:00Z",
            },
          ],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    process.env["JHIN_BITBUCKET_API_BASE_URL"] = `http://127.0.0.1:${port}/2.0`;
    process.env["JHIN_BITBUCKET_ACCESS_TOKEN"] = "secret";
    const sc = await node();
    const projectId = await sc.project(repositoryAt("git@bitbucket.org:acme/demo.git"));
    expect(only(await sc.status(projectId, true)).pullRequests["feature"]).toMatchObject({
      number: 8,
      state: "open",
      checks: { state: "passing" },
    });
    expect(seen[0]).toEqual({
      url: expect.stringMatching(
        /^\/2\.0\/repositories\/acme\/demo\/pullrequests\?q=source\.branch\.name/,
      ),
      authorization: "Bearer secret",
    });
  });

  it("says when the node has no token", async () => {
    const sc = await node();
    const projectId = await sc.project(repositoryAt("git@bitbucket.org:acme/demo.git"));
    expect(only(await sc.status(projectId, true)).provider).toEqual({
      kind: "bitbucket",
      available: false,
      reason:
        "Bitbucket needs a token on this node: set JHIN_BITBUCKET_ACCESS_TOKEN, or JHIN_BITBUCKET_EMAIL and JHIN_BITBUCKET_API_TOKEN",
    });
  });
});
