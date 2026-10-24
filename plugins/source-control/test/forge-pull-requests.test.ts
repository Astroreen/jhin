// Bitbucket and Forgejo listed, watched and resolved, and pull requests checked out on every
// forge (docs/plans/source-control.md D1441–D1446), against a local Bitbucket server and fake
// `tea`, `glab` and `az`.
import * as Http from "node:http";

import type { PullRequest } from "@jhin/source-control-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { bitbucketForge } from "../src/bitbucket.ts";
import { checkoutLocal, checkoutWorktree, isPullRequestOf } from "../src/checkout.ts";
import { forgejoForge } from "../src/forgejo.ts";
import { azureForge, gitlabForge } from "../src/forges.ts";
import { createGit } from "../src/git.ts";
import { fakeCli, git, node, repository, repositoryAt, temp, watching, write } from "./support.ts";

/** A local Bitbucket API: answers by path (the longest matching prefix), and records calls. */
async function bitbucketServer() {
  const answers = new Map<string, unknown>();
  const seen: { url: string; authorization: string | undefined }[] = [];
  const server = Http.createServer((request, response) => {
    const url = request.url ?? "";
    seen.push({ url, authorization: request.headers.authorization });
    const path = url.replace(/^\/2\.0/, "");
    const key = [...answers.keys()]
      .filter((prefix) => path === prefix || path.startsWith(`${prefix}?`))
      .toSorted((a, b) => b.length - a.length)[0];
    response.setHeader("content-type", "application/json");
    if (key === undefined) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: `No ${path}` } }));
      return;
    }
    response.end(JSON.stringify(answers.get(key)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}/2.0`,
    answer: (path: string, value: unknown) => answers.set(path, value),
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const bitbucketPr = (fields: Record<string, unknown> = {}) => ({
  id: 8,
  title: "Add a",
  state: "OPEN",
  links: { html: { href: "https://bitbucket.org/acme/demo/pull-requests/8" } },
  source: {
    branch: { name: "feature" },
    commit: { hash: "abcdef1234" },
    repository: { full_name: "acme/demo" },
  },
  destination: { branch: { name: "main" }, repository: { full_name: "acme/demo" } },
  author: { nickname: "author" },
  updated_on: "2026-10-20T10:00:00Z",
  ...fields,
});

const forgejoPr = (fields: Record<string, unknown> = {}) => ({
  number: 2,
  title: "Add a",
  html_url: "https://codeberg.org/acme/demo/pulls/2",
  state: "open",
  merged: false,
  user: { login: "author" },
  head: {
    ref: "feature",
    sha: "abcdef1234",
    repo: { full_name: "acme/demo", owner: { login: "acme" } },
  },
  base: { ref: "main", repo: { full_name: "acme/demo" } },
  updated_at: "2026-10-20T10:00:00Z",
  ...fields,
});

describe("jhin.source-control: Bitbucket listed, watched and resolved (D1441–D1443, D1446)", () => {
  const servers: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });
  const start = async () => {
    const server = await bitbucketServer();
    servers.push(server);
    return server;
  };

  it("lists a repository's pull requests with words searched on Bitbucket, with the config's token", async () => {
    const server = await start();
    server.answer("/repositories/acme/demo/pullrequests", {
      values: [bitbucketPr({ id: 9, title: "Port the toolbar", state: "MERGED" }), bitbucketPr()],
    });
    const sc = await node({
      bitbucketAccessToken: "from-config",
      bitbucketApiBaseUrl: server.base,
    });
    const projectId = await sc.project(repositoryAt("git@bitbucket.org:acme/demo.git"));
    const { pullRequests } = await sc.client.call<{ pullRequests: PullRequest[] }>(
      "git.pr.search",
      { projectId, query: 'tool"bar' },
    );
    expect(pullRequests.map((pr) => [pr.number, pr.state])).toEqual([
      [9, "merged"],
      [8, "open"],
    ]);
    const call = server.seen.find((item) => item.url.includes("&q="))!;
    expect(call.authorization).toBe("Bearer from-config");
    expect(decodeURIComponent(call.url)).toContain(
      'pagelen=30&sort=-updated_on&q=(title ~ "tool\\"bar" OR description ~ "tool\\"bar")',
    );
    expect(call.url).toContain("state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED");
  });

  it("watches a pull request: a failed status, a comment on a line and a conflict wake the thread", async () => {
    const server = await start();
    const path = "/repositories/acme/demo/pullrequests/8";
    server.answer(path, bitbucketPr());
    server.answer(`${path}/statuses`, {
      values: [{ key: "ci", name: "Build", state: "INPROGRESS" }],
    });
    server.answer(`${path}/conflicts`, { values: [] });
    server.answer(`${path}/comments`, { values: [] });
    server.answer("/user", { nickname: "me" });
    process.env["JHIN_BITBUCKET_ACCESS_TOKEN"] = "from-env";
    process.env["JHIN_BITBUCKET_API_BASE_URL"] = server.base;
    try {
      const { sc, thread, until } = await watching("git@bitbucket.org:acme/demo.git");
      const url = "https://bitbucket.org/acme/demo/pull-requests/8";
      await expect(
        sc.client.call("git.pr.watch", { threadId: thread.id, url }),
      ).resolves.toMatchObject({ watching: true });
      expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 0 });
      server.answer(`${path}/statuses`, {
        values: [{ key: "ci", name: "Build", state: "FAILED", url: "https://ci.example/build/3" }],
      });
      server.answer(`${path}/conflicts`, { values: [{ path: "a.txt" }] });
      server.answer(`${path}/comments`, {
        values: [
          {
            id: 1,
            content: { raw: "Mine" },
            user: { nickname: "me" },
            created_on: "2099-01-01T00:00:00Z",
          },
          {
            id: 2,
            content: { raw: "Gone" },
            deleted: true,
            user: { nickname: "reviewer" },
            created_on: "2099-01-01T00:00:00Z",
          },
          {
            id: 3,
            content: { raw: "Looks off" },
            inline: { path: "src/a.ts", to: 3 },
            user: { nickname: "reviewer" },
            created_on: "2099-01-01T00:00:01Z",
          },
        ],
      });
      expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 1 });
      await until(
        (text) =>
          text.startsWith(`Update on pull request #8 (${url}), which Jhin is watching for you:`) &&
          text.includes("- Checks failed on abcdef1:\n  - Build https://ci.example/build/3") &&
          text.includes('- 1 new comment:\n  - reviewer on src/a.ts: "Looks off"') &&
          text.includes("- The branch now conflicts with main."),
      );
      expect(server.seen.every((item) => item.authorization === "Bearer from-env")).toBe(true);
    } finally {
      delete process.env["JHIN_BITBUCKET_ACCESS_TOKEN"];
      delete process.env["JHIN_BITBUCKET_API_BASE_URL"];
    }
  });

  it("follows a next link only on the API's own origin, so the token goes nowhere else", async () => {
    const server = await start();
    server.answer("/repositories/acme/demo/pullrequests", {
      values: [bitbucketPr()],
      next: "https://elsewhere.example/2.0/repositories/acme/demo/pullrequests?page=2",
    });
    const sc = await node({ bitbucketAccessToken: "t", bitbucketApiBaseUrl: server.base });
    const projectId = await sc.project(repositoryAt("git@bitbucket.org:acme/demo.git"));
    await expect(
      sc.client.call("git.pr.search", { projectId, query: "a", limit: 100 }),
    ).rejects.toThrow(
      "Bitbucket answered a link to another host: https://elsewhere.example/2.0/repositories/acme/demo/pullrequests?page=2",
    );
  });

  it("resolves a number or a URL, and refuses a branch with T3's words", async () => {
    const server = await start();
    server.answer("/repositories/acme/demo/pullrequests/8", bitbucketPr());
    server.answer("/repositories/acme/demo/pullrequests/8/statuses", { values: [] });
    const sc = await node({ bitbucketAccessToken: "t", bitbucketApiBaseUrl: server.base });
    const projectId = await sc.project(repositoryAt("git@bitbucket.org:acme/demo.git"));
    for (const reference of ["#8", "https://bitbucket.org/acme/demo/pull-requests/8"]) {
      const { pullRequest } = await sc.client.call<{ pullRequest: PullRequest }>("git.pr.resolve", {
        projectId,
        reference,
      });
      expect(pullRequest).toMatchObject({
        number: 8,
        headBranch: "feature",
        headSha: "abcdef1234",
      });
    }
    await expect(
      sc.client.call("git.pr.resolve", { projectId, reference: "feature" }),
    ).rejects.toThrow("Specify a pull request number or Bitbucket pull request URL.");
  });
});

describe("jhin.source-control: Forgejo listed, watched and resolved through tea (D1441–D1443)", () => {
  it("lists pull requests, matching words against their titles as T3 searches none there", async () => {
    const tea = fakeCli("tea");
    tea.answer("api /repos/acme/demo/pulls?state=all&sort=recentupdate&limit=50&page=1", [
      forgejoPr({ number: 3, title: "Port the toolbar" }),
      forgejoPr({ number: 2, title: "Add a" }),
    ]);
    const sc = await node();
    const projectId = await sc.project(repositoryAt("https://codeberg.org/acme/demo.git"));
    const search = async (query: string) =>
      (
        await sc.client.call<{ pullRequests: PullRequest[] }>("git.pr.search", {
          projectId,
          query,
        })
      ).pullRequests.map((pr) => pr.number);
    expect(await search("toolbar")).toEqual([3]);
    expect(await search("#2")).toEqual([2]);
  });

  it("watches a pull request: a failed status and a review comment on a line wake the thread", async () => {
    const tea = fakeCli("tea");
    const path = "api /repos/acme/demo/pulls/2";
    tea.answer(path, forgejoPr({ mergeable: true }));
    tea.answer("api /repos/acme/demo/statuses/abcdef1234", [
      { context: "ci/build", status: "pending" },
    ]);
    tea.answer("api /repos/acme/demo/issues/2/comments", []);
    tea.answer(`${path}/reviews`, []);
    tea.answer("api /user", { login: "me" });
    const { sc, thread, until } = await watching("https://codeberg.org/acme/demo.git");
    const url = "https://codeberg.org/acme/demo/pulls/2";
    await expect(
      sc.client.call("git.pr.watch", { threadId: thread.id, url }),
    ).resolves.toMatchObject({ watching: true });
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 0 });
    tea.answer("api /repos/acme/demo/statuses/abcdef1234", [
      { context: "ci/build", status: "error", target_url: "https://ci.example/2" },
    ]);
    tea.answer(`${path}/reviews`, [
      {
        id: 5,
        state: "PENDING",
        body: "Not sent",
        user: { login: "reviewer" },
        submitted_at: "2099-01-01T00:00:00Z",
      },
      {
        id: 6,
        state: "REQUEST_CHANGES",
        body: "",
        comments_count: 1,
        user: { login: "reviewer" },
        submitted_at: "2099-01-01T00:00:01Z",
      },
    ]);
    tea.answer(`${path}/reviews/6/comments`, [
      {
        id: 7,
        body: "Rename this",
        path: "src/a.ts",
        user: { login: "reviewer" },
        created_at: "2099-01-01T00:00:01Z",
      },
    ]);
    expect(await sc.client.call("git.pr.watch.check", {})).toEqual({ checked: 1, woken: 1 });
    await until(
      (text) =>
        text.includes("- Checks failed on abcdef1:\n  - ci/build https://ci.example/2") &&
        text.includes("- 2 new comments:") &&
        text.includes("reviewer: CHANGES_REQUESTED") &&
        text.includes('reviewer on src/a.ts: "Rename this"'),
    );
  });

  it("resolves a number, and refuses a branch", async () => {
    const tea = fakeCli("tea");
    tea.answer("api /repos/acme/demo/pulls/2", forgejoPr());
    tea.answer("api /repos/acme/demo/statuses/abcdef1234", []);
    const sc = await node();
    const projectId = await sc.project(repositoryAt("https://codeberg.org/acme/demo.git"));
    const { pullRequest } = await sc.client.call<{ pullRequest: PullRequest }>("git.pr.resolve", {
      projectId,
      reference: "2",
    });
    expect(pullRequest).toMatchObject({ number: 2, state: "open" });
    await expect(
      sc.client.call("git.pr.resolve", { projectId, reference: "feature" }),
    ).rejects.toThrow("Specify a pull request number or Forgejo pull request URL.");
  });
});

/**
 * A clone whose `origin` is `remoteUrl`, served from a local bare repository through
 * `insteadOf`, where branch `feature` is one commit past `main`; `pullRef` also publishes
 * it as `refs/pull/<n>/head`.
 */
function forgeRepository(remoteUrl: string, pullRef?: number) {
  const upstream = repository();
  write(upstream, "feature.txt", "feature\n");
  git(upstream, "switch", "--quiet", "--create", "feature");
  git(upstream, "add", "feature.txt");
  git(upstream, "commit", "--quiet", "-m", "Add the thing");
  const head = git(upstream, "rev-parse", "HEAD").trim();
  git(upstream, "switch", "--quiet", "main");
  const origin = temp("jhin-sc-origin-");
  git(origin, "clone", "--quiet", "--bare", upstream, ".");
  if (pullRef !== undefined) git(origin, "update-ref", `refs/pull/${pullRef}/head`, head);
  const dir = temp("jhin-sc-clone-");
  git(dir, "clone", "--quiet", origin, ".");
  git(dir, "remote", "set-url", "origin", remoteUrl);
  git(dir, "config", `url.${origin}.insteadOf`, remoteUrl);
  return { dir, origin, head };
}

describe("checking a pull request out on every forge (D1444)", () => {
  const servers: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });
  const warn = () => undefined;
  const site = (dir: string, host: string, path: string) => ({ cwd: dir, host, repository: path });

  it("tells every forge's pull request URLs of a repository from another's", () => {
    for (const [remote, url] of [
      ["git@gitlab.com:acme/demo.git", "https://gitlab.com/acme/demo/-/merge_requests/5"],
      ["https://bitbucket.org/acme/demo.git", "https://bitbucket.org/acme/demo/pull-requests/8"],
      ["https://codeberg.org/acme/demo.git", "https://codeberg.org/acme/demo/pulls/2"],
      [
        "https://acme@dev.azure.com/acme/web/_git/demo",
        "https://dev.azure.com/acme/web/_git/demo/pullrequest/4",
      ],
    ] as const) {
      expect(isPullRequestOf(remote, url)).toBe(true);
      expect(isPullRequestOf(remote, url.replace("acme/", "other/"))).toBe(false);
    }
  });

  it("checks a GitLab merge request out from its head branch, refs/pull being absent", async () => {
    const glab = fakeCli("glab");
    glab.answer("api --hostname gitlab.com projects/acme%2Fdemo/merge_requests/5", {
      iid: 5,
      title: "Add a",
      web_url: "https://gitlab.com/acme/demo/-/merge_requests/5",
      state: "opened",
      source_branch: "feature",
      target_branch: "main",
      source_project_id: 1,
      target_project_id: 1,
    });
    const { dir, origin, head } = forgeRepository("https://gitlab.com/acme/demo");
    const target = await gitlabForge(() => "glab", site(dir, "gitlab.com", "acme/demo"), new Map())
      .resolve!("#5");
    expect(target).toMatchObject({ pullRefs: false, crossRepository: false });
    const prepared = await checkoutLocal(createGit("git", dir), target, warn);
    expect(prepared).toMatchObject({ branch: "feature", worktreePath: null });
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);

    // With the branch gone there is no refs/pull to fall back to.
    git(dir, "switch", "--quiet", "main");
    git(dir, "branch", "-D", "feature");
    git(origin, "branch", "-D", "feature");
    await expect(checkoutLocal(createGit("git", dir), target, warn)).rejects.toThrow(
      "The pull request could not be checked out with git.",
    );
  });

  it("checks a GitLab merge request of a fork out from the fork's project", async () => {
    const glab = fakeCli("glab");
    glab.answer("api --hostname gitlab.com projects/acme%2Fdemo/merge_requests/6", {
      iid: 6,
      title: "Add a",
      web_url: "https://gitlab.com/acme/demo/-/merge_requests/6",
      state: "opened",
      source_branch: "feature",
      target_branch: "main",
      source_project_id: 2,
      target_project_id: 1,
    });
    glab.answer("api --hostname gitlab.com projects/2", { path_with_namespace: "someone/demo" });
    const { dir } = forgeRepository("https://gitlab.com/acme/demo");
    const target = await gitlabForge(() => "glab", site(dir, "gitlab.com", "acme/demo"), new Map())
      .resolve!("6");
    expect(target).toMatchObject({
      crossRepository: true,
      headRepository: "someone/demo",
      headOwner: "someone",
      pullRefs: false,
    });
  });

  it("checks an Azure DevOps pull request out in a worktree", async () => {
    const az = fakeCli("az");
    az.answer("repos pr show --id 4 --organization https://dev.azure.com/acme", {
      pullRequestId: 4,
      title: "Add a",
      status: "active",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      repository: { webUrl: "https://dev.azure.com/acme/web/_git/demo" },
    });
    const { dir, head } = forgeRepository("https://dev.azure.com/acme/web/_git/demo");
    const target = await azureForge(
      () => "az",
      site(dir, "dev.azure.com", "acme/web/_git/demo"),
      new Map(),
    ).resolve!("4");
    const prepared = await checkoutWorktree(createGit("git", dir), target, {
      repository: dir,
      root: temp("jhin-sc-worktrees-"),
      createGit: (cwd) => createGit("git", cwd),
      warn,
    });
    expect(prepared).toMatchObject({ branch: "feature", isOnPullRequestHead: true });
    expect(git(prepared.worktreePath!, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("checks a Bitbucket pull request out, and a Forgejo one from refs/pull when its branch is gone", async () => {
    const server = await bitbucketServer();
    servers.push(server);
    server.answer("/repositories/acme/demo/pullrequests/8", bitbucketPr());
    server.answer("/repositories/acme/demo/pullrequests/8/statuses", { values: [] });
    const bitbucket = forgeRepository("https://bitbucket.org/acme/demo");
    const fromBitbucket = await bitbucketForge(
      site(bitbucket.dir, "bitbucket.org", "acme/demo"),
      () => ({ accessToken: "t", apiBaseUrl: server.base }),
      new Map(),
    ).resolve!("8");
    expect(fromBitbucket.pullRefs).toBe(false);
    const prepared = await checkoutLocal(createGit("git", bitbucket.dir), fromBitbucket, warn);
    expect(prepared.branch).toBe("feature");
    expect(git(bitbucket.dir, "rev-parse", "HEAD").trim()).toBe(bitbucket.head);

    const tea = fakeCli("tea");
    tea.answer("api /repos/acme/demo/pulls/2", forgejoPr({ state: "closed", merged: true }));
    tea.answer("api /repos/acme/demo/statuses/abcdef1234", []);
    const forgejo = forgeRepository("https://codeberg.org/acme/demo", 2);
    git(forgejo.origin, "branch", "-D", "feature");
    const fromForgejo = await forgejoForge(
      () => "tea",
      site(forgejo.dir, "codeberg.org", "acme/demo"),
      new Map(),
    ).resolve!("2");
    expect(fromForgejo.pullRefs).toBe(true);
    const fromRef = await checkoutLocal(createGit("git", forgejo.dir), fromForgejo, warn);
    expect(fromRef.branch).toBe("feature");
    expect(git(forgejo.dir, "rev-parse", "HEAD").trim()).toBe(forgejo.head);
  });
});
