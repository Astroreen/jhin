import * as Fs from "node:fs";
import * as Path from "node:path";

import type { PreparedPullRequest, PullRequest } from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import { checkoutLocal, checkoutWorktree, normalizeReference } from "../src/checkout.ts";
import type { CheckoutTarget } from "../src/forge.ts";
import { createGit } from "../src/git.ts";
import { fakeGh, ghPullRequest, git, node, repository, temp, write } from "./support.ts";

const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  title: "Add the thing",
  url: "https://github.com/acme/demo/pull/7",
  state: "open",
  isDraft: false,
  headBranch: "feature",
  baseBranch: "main",
  checks: { state: null, total: 0, passed: 0, failed: 0, pending: 0 },
  ...fields,
});

/**
 * A clone of a bare `origin` whose branch `feature` is pull request 7: pushed
 * as a branch and published as `refs/pull/7/head`, one commit past `main`.
 */
function withPullRequest() {
  const upstream = repository();
  write(upstream, "feature.txt", "feature\n");
  git(upstream, "switch", "--quiet", "--create", "feature");
  git(upstream, "add", "feature.txt");
  git(upstream, "commit", "--quiet", "-m", "Add the thing");
  const head = git(upstream, "rev-parse", "HEAD").trim();
  git(upstream, "switch", "--quiet", "main");
  const origin = temp("jhin-sc-origin-");
  git(origin, "clone", "--quiet", "--bare", upstream, ".");
  git(origin, "update-ref", "refs/pull/7/head", head);
  const dir = temp("jhin-sc-clone-");
  git(dir, "clone", "--quiet", origin, ".");
  return { dir, origin, head };
}

const warn = () => undefined;

describe("checking a pull request out (D902)", () => {
  it("normalizes a reference as T3 does", () => {
    expect(normalizeReference(" #42 ")).toBe("42");
    expect(normalizeReference("42")).toBe("42");
    expect(normalizeReference("https://github.com/acme/demo/pull/42")).toBe(
      "https://github.com/acme/demo/pull/42",
    );
  });

  it("checks it out in the project's checkout, tracking its head branch", async () => {
    const { dir, head } = withPullRequest();
    const target: CheckoutTarget = { pr: pr(), crossRepository: false };
    const prepared = await checkoutLocal(createGit("git", dir), target, warn);
    expect(prepared).toEqual({
      pullRequest: target.pr,
      branch: "feature",
      worktreePath: null,
      isOnPullRequestHead: true,
    } satisfies PreparedPullRequest);
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(dir, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/feature");
  });

  it("checks a pull request out in a new worktree, then reuses that worktree", async () => {
    const { dir, head } = withPullRequest();
    const root = temp("jhin-sc-worktrees-");
    const options = {
      repository: dir,
      root,
      createGit: (cwd: string) => createGit("git", cwd),
      warn,
    };
    const target: CheckoutTarget = { pr: pr(), crossRepository: false };
    const prepared = await checkoutWorktree(createGit("git", dir), target, options);
    expect(prepared.branch).toBe("feature");
    expect(prepared.worktreePath).toBe(Path.join(root, Path.basename(dir), "feature"));
    expect(prepared.isOnPullRequestHead).toBe(true);
    const path = prepared.worktreePath!;
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(path, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/feature");
    // The project's own checkout stays where it was.
    expect(git(dir, "branch", "--show-current").trim()).toBe("main");

    const again = await checkoutWorktree(createGit("git", dir), target, options);
    expect(again).toEqual(prepared);
  });

  it("refuses a worktree of the branch the project's checkout is on", async () => {
    const { dir } = withPullRequest();
    git(dir, "switch", "--quiet", "feature");
    await expect(
      checkoutWorktree(
        createGit("git", dir),
        { pr: pr(), crossRepository: false },
        {
          repository: dir,
          root: temp("jhin-sc-worktrees-"),
          createGit: (cwd) => createGit("git", cwd),
          warn,
        },
      ),
    ).rejects.toThrow(
      "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
    );
  });

  it("names a fork's worktree branch jhin/pr-<n>/<head> and tracks the fork", async () => {
    const { dir, head } = withPullRequest();
    // The fork, reached through its GitHub URL.
    const fork = temp("jhin-sc-fork-");
    git(fork, "clone", "--quiet", "--bare", dir, ".");
    git(fork, "fetch", "--quiet", Path.join(dir, ".git"), `${head}:refs/heads/Fix/Login`);
    git(dir, "config", `url.${fork}.insteadOf`, "https://github.com/someone/demo.git");
    const target: CheckoutTarget = {
      pr: pr({ headBranch: "Fix/Login" }),
      crossRepository: true,
      headOwner: "someone",
      headRepository: "someone/demo",
    };
    const prepared = await checkoutWorktree(createGit("git", dir), target, {
      repository: dir,
      root: temp("jhin-sc-worktrees-"),
      createGit: (cwd) => createGit("git", cwd),
      warn,
    });
    expect(prepared.branch).toBe("jhin/pr-7/fix/login");
    expect(git(prepared.worktreePath!, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(prepared.worktreePath!, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe(
      "someone/Fix/Login",
    );
  });

  it("falls back to the pull request's ref when its head branch is gone", async () => {
    const { dir, origin, head } = withPullRequest();
    git(origin, "branch", "-D", "feature");
    const prepared = await checkoutLocal(
      createGit("git", dir),
      { pr: pr({ state: "merged" }), crossRepository: false },
      warn,
    );
    expect(prepared.branch).toBe("feature");
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
  });
});

describe("git.pr.resolve and git.pr.checkout", () => {
  it("resolves a pull request through the forge, and refuses a repository without one", async () => {
    const gh = fakeGh();
    gh.view(7, ghPullRequest());
    const dir = repository();
    git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    const sc = await node();
    const projectId = await sc.project(dir);
    const { pullRequest } = await sc.client.call<{ pullRequest: PullRequest }>("git.pr.resolve", {
      projectId,
      reference: "#7",
    });
    expect(pullRequest).toMatchObject({ number: 7, headBranch: "feature", baseBranch: "main" });
    expect(gh.calls().some((call) => call.startsWith("pr view 7 --json"))).toBe(true);

    const plain = await sc.project(repository());
    await expect(
      sc.client.call("git.pr.checkout", { projectId: plain, reference: "7", mode: "local" }),
    ).rejects.toThrow("This repository has no remote on a known forge.");
    expect(Fs.existsSync(dir)).toBe(true);
  });
});
