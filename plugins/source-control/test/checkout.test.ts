import * as Fs from "node:fs";
import * as Path from "node:path";

import type { PreparedPullRequest, PullRequest } from "@jhin/source-control-api";
import { describe, expect, it } from "vite-plus/test";

import {
  checkoutLocal,
  checkoutWorktree,
  isPullRequestOf,
  normalizeReference,
} from "../src/checkout.ts";
import { githubForge } from "../src/github.ts";
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
  it("tells a pull request of the remote's repository from another's", () => {
    const url = "https://github.com/acme/demo/pull/7";
    expect(isPullRequestOf("https://github.com/acme/demo.git", url)).toBe(true);
    expect(isPullRequestOf("git@github.com:Acme/demo.git", url)).toBe(true);
    expect(isPullRequestOf("ssh://git@github.com/acme/demo", url)).toBe(true);
    expect(isPullRequestOf("https://github.com/acme/other.git", url)).toBe(false);
    expect(
      isPullRequestOf(
        "ssh://git@ghe.example:2222/acme/demo.git",
        "https://ghe.example/acme/demo/pull/7",
      ),
    ).toBe(true);
  });

  it("reads a fork's head repository from gh", async () => {
    const gh = fakeGh();
    gh.view(
      7,
      ghPullRequest({
        isCrossRepository: true,
        headRepositoryOwner: { login: "someone" },
        headRepository: { name: "demo-fork" },
      }),
    );
    const target = await githubForge(() => "gh", repository(), new Map()).resolve!("7");
    expect(target).toMatchObject({
      crossRepository: true,
      headOwner: "someone",
      headRepository: "someone/demo-fork",
      pr: { number: 7, headBranch: "feature" },
    });
  });

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

    // Its folder deleted, the worktree is made again rather than reused.
    Fs.rmSync(path, { recursive: true, force: true });
    const remade = await checkoutWorktree(createGit("git", dir), target, options);
    expect(remade).toEqual(prepared);
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(head);
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

  it("reads the pull request from its repository's remote when origin is a fork", async () => {
    const { dir: upstreamClone, origin: upstream, head } = withPullRequest();
    // `origin` is the user's fork, without the pull request; `upstream` has it.
    const dir = temp("jhin-sc-forked-");
    const fork = temp("jhin-sc-own-fork-");
    git(fork, "clone", "--quiet", "--bare", upstreamClone, ".");
    git(dir, "clone", "--quiet", fork, ".");
    git(dir, "remote", "add", "upstream", "https://github.com/acme/demo");
    git(dir, "config", `url.${upstream}.insteadOf`, "https://github.com/acme/demo");
    const prepared = await checkoutLocal(
      createGit("git", dir),
      { pr: pr(), crossRepository: false },
      warn,
    );
    expect(prepared.branch).toBe("feature");
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(dir, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("upstream/feature");
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

describe("checking a pull request out without losing work (D902)", () => {
  const worktreeOptions = () => ({
    root: temp("jhin-sc-worktrees-"),
    createGit: (cwd: string) => createGit("git", cwd),
    warn,
  });
  const commit = (dir: string, file: string) => {
    write(dir, file, `${file}\n`);
    git(dir, "add", file);
    git(dir, "commit", "--quiet", "-m", `Add ${file}`);
  };

  it("refuses a project checkout with changes, and a branch with commits of its own", async () => {
    const { dir } = withPullRequest();
    const target: CheckoutTarget = { pr: pr(), crossRepository: false };
    write(dir, "draft.txt", "mine\n");
    await expect(checkoutLocal(createGit("git", dir), target, warn)).rejects.toThrow(
      "Commit or stash the changes in the project's checkout before checking a pull request out in it.",
    );
    expect(Fs.readFileSync(Path.join(dir, "draft.txt"), "utf8")).toBe("mine\n");
    Fs.rmSync(Path.join(dir, "draft.txt"));

    git(dir, "switch", "--quiet", "--create", "feature", "main");
    commit(dir, "local.txt");
    git(dir, "switch", "--quiet", "main");
    await expect(checkoutLocal(createGit("git", dir), target, warn)).rejects.toThrow(
      "Branch 'feature' has commits that pull request #7 does not. Push or move them, then check it out again.",
    );
    expect(git(dir, "branch", "--show-current").trim()).toBe("main");
  });

  it("moves an existing branch that is behind forward", async () => {
    const { dir, head } = withPullRequest();
    git(dir, "branch", "feature", "main");
    await checkoutLocal(createGit("git", dir), { pr: pr(), crossRepository: false }, warn);
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("names a fork's head like its base after its owner, reusing the fork's remote", async () => {
    const { dir, head } = withPullRequest();
    const fork = temp("jhin-sc-fork-");
    git(fork, "clone", "--quiet", "--bare", dir, ".");
    git(fork, "fetch", "--quiet", Path.join(dir, ".git"), `+${head}:refs/heads/main`);
    git(dir, "config", `url.${fork}.insteadOf`, "https://github.com/someone/demo");
    git(dir, "remote", "add", "theirs", "https://github.com/someone/demo");
    const prepared = await checkoutLocal(
      createGit("git", dir),
      {
        pr: pr({ headBranch: "main" }),
        crossRepository: true,
        headOwner: "someone",
        headRepository: "someone/demo",
      },
      warn,
    );
    expect(prepared.branch).toBe("someone/main");
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(dir, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("theirs/main");
    expect(git(dir, "remote").trim().split("\n").toSorted()).toEqual(["origin", "theirs"]);
  });

  it("fast-forwards a reused worktree that is behind, and leaves one with changes", async () => {
    const { dir, origin, head } = withPullRequest();
    const options = { repository: dir, ...worktreeOptions() };
    const target: CheckoutTarget = { pr: pr(), crossRepository: false };
    const first = await checkoutWorktree(createGit("git", dir), target, options);
    const path = first.worktreePath!;

    // The pull request moves on.
    const pusher = temp("jhin-sc-pusher-");
    git(pusher, "clone", "--quiet", "--branch", "feature", origin, ".");
    commit(pusher, "more.txt");
    git(pusher, "push", "--quiet", "origin", "feature");
    const next = git(pusher, "rev-parse", "HEAD").trim();
    git(origin, "update-ref", "refs/pull/7/head", next);

    const behind = await checkoutWorktree(createGit("git", dir), target, options);
    expect(behind.isOnPullRequestHead).toBe(true);
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(next);

    git(path, "reset", "--quiet", "--hard", head);
    write(path, "wip.txt", "wip\n");
    const dirty = await checkoutWorktree(createGit("git", dir), target, options);
    expect(dirty.isOnPullRequestHead).toBe(false);
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("keeps a fork away from this repository's same-named branch and its own stale commits", async () => {
    const { dir, head } = withPullRequest();
    const fork = temp("jhin-sc-fork-");
    git(fork, "clone", "--quiet", "--bare", dir, ".");
    git(fork, "fetch", "--quiet", Path.join(dir, ".git"), `+${head}:refs/heads/feature`);
    git(dir, "config", `url.${fork}.insteadOf`, "https://github.com/someone/demo.git");
    // This repository's own `feature`, in a worktree of its own.
    const mine = Path.join(temp("jhin-sc-mine-"), "feature");
    git(dir, "worktree", "add", "--quiet", "-b", "feature", mine, "main");
    const target: CheckoutTarget = {
      pr: pr(),
      crossRepository: true,
      headOwner: "someone",
      headRepository: "someone/demo",
    };
    const prepared = await checkoutWorktree(createGit("git", dir), target, {
      repository: dir,
      ...worktreeOptions(),
    });
    expect(prepared.branch).toBe("jhin/pr-7/feature");
    expect(prepared.worktreePath).not.toBe(mine);

    // Its branch got a commit of its own and lost its worktree: it is not moved.
    commit(prepared.worktreePath!, "own.txt");
    git(dir, "worktree", "remove", "--force", prepared.worktreePath!);
    await expect(
      checkoutWorktree(createGit("git", dir), target, { repository: dir, ...worktreeOptions() }),
    ).rejects.toThrow("Branch 'jhin/pr-7/feature' has commits that pull request #7 does not.");
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
    expect(gh.calls().some((call) => /^pr view --json \S+ -- 7$/.test(call))).toBe(true);

    // An unknown pull request, and a reference that would read as an option.
    await expect(
      sc.client.call("git.pr.checkout", { projectId, reference: "8", mode: "worktree" }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_FAILED" });
    await expect(
      sc.client.call("git.pr.resolve", { projectId, reference: "-R other/repo" }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_INVALID" });

    // Another repository's pull request, by URL.
    gh.view(9, ghPullRequest({ number: 9, url: "https://github.com/other/repo/pull/9" }));
    await expect(
      sc.client.call("git.pr.checkout", {
        projectId,
        reference: "https://github.com/other/repo/pull/9",
        mode: "local",
      }),
    ).rejects.toThrow(
      "https://github.com/other/repo/pull/9 is not a pull request of this project's repository.",
    );

    // A forge that cannot check pull requests out yet.
    const gitlab = repository();
    git(gitlab, "remote", "add", "origin", "https://gitlab.com/acme/demo.git");
    await expect(
      sc.client.call("git.pr.resolve", { projectId: await sc.project(gitlab), reference: "7" }),
    ).rejects.toMatchObject({ code: "ACTION_UNAVAILABLE" });

    const plain = await sc.project(repository());
    await expect(
      sc.client.call("git.pr.checkout", { projectId: plain, reference: "7", mode: "local" }),
    ).rejects.toThrow("This repository has no remote on a known forge.");
  });
});
