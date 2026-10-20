// Git actions follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/git/GitManager.ts (runStackedAction: the feature branch, commit, push and
// pull request phases, the base branch of a pull request, the result's toast and its call to
// action), packages/shared/src/git.ts (sanitizeBranchFragment, sanitizeFeatureBranchName,
// resolveAutoFeatureBranchName) and apps/server/src/vcs/GitVcsDriverCore.ts (staging into a
// temporary index, the push remote, pushing with an upstream, `pull --ff-only`).
import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import type {
  ChangeRequestTerminology,
  GitActionCta,
  GitActionPhase,
  GitActionProgress,
  GitActionResult,
  GitStackedAction,
  PullRequest,
  PullResult,
} from "@jhin/source-control-api";

import { SourceControlError, type Git } from "./git.ts";
import type { Writer } from "./writer.ts";

/** A commit's hooks may run a whole test suite. */
const COMMIT_TIMEOUT_MS = 10 * 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
/** A pull fetches over the network and may merge: as long as a push may take. */
const PULL_TIMEOUT_MS = 5 * 60_000;
/** A line of a hook's output is cut here. */
const MAX_PROGRESS_TEXT = 500;
/** Lines of a commit's hooks published per action; the rest only end up in git's error. */
const MAX_HOOK_LINES = 200;
const MAX_SUMMARY = 8_000;
const MAX_PATCH = 50_000;
/** git's empty tree: what an unborn `HEAD` is compared against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Where pull requests of the repository are created (the GitHub CLI, or another forge). */
export interface PullRequestCreator {
  readonly terminology: ChangeRequestTerminology;
  /** The newest pull request whose head is `branch`, any state, or `null`. */
  find(branch: string): Promise<PullRequest | null>;
  create(input: {
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly bodyFile: string;
  }): Promise<PullRequest>;
  /** The repository's template for a pull request's body, read at `ref`. */
  template?(ref: string): Promise<string | undefined>;
}

export const DEFAULT_TERMINOLOGY: ChangeRequestTerminology = {
  singular: "pull request",
  shortLabel: "PR",
};

type ProgressEvent = GitActionProgress extends infer E
  ? E extends GitActionProgress
    ? Omit<E, "actionId" | "projectId" | "action">
    : never
  : never;

export interface ActionRun {
  readonly git: Git;
  readonly root: string;
  readonly gitDir: string;
  readonly action: GitStackedAction;
  readonly commitMessage?: string | undefined;
  readonly featureBranch?: boolean | undefined;
  readonly filePaths?: readonly string[] | undefined;
  /** The repository's default branch, if known. */
  readonly defaultBranch: string | null;
  readonly forge: PullRequestCreator | undefined;
  readonly writer: Writer;
  progress(event: ProgressEvent): void;
}

const fail = (message: string): never => {
  throw new SourceControlError("ACTION_UNAVAILABLE", message);
};

// --- Branch names (packages/shared/src/git.ts) ----------------------------------------------

function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");
  const fragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");
  return fragment.length > 0 ? fragment : "update";
}

export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  return sanitized.includes("/") ? sanitized : `feature/${sanitized}`;
}

/** A feature branch named after `preferred`, `-2`, `-3`… when taken (case-insensitively). */
export function resolveAutoFeatureBranchName(
  existing: readonly string[],
  preferred?: string,
): string {
  const wanted = preferred?.trim();
  const base = sanitizeFeatureBranchName(
    wanted !== undefined && wanted.length > 0 ? wanted : "feature/update",
  );
  const names = existing.map((name) => name.toLowerCase());
  const taken = new Set(names);
  const parts = base.split("/");
  let resolved = "";
  for (const [index, part] of parts.entries()) {
    const prefix = resolved ? `${resolved}/${part}` : part;
    let candidate = prefix;
    let suffix = 2;
    while (
      taken.has(candidate) ||
      (index === parts.length - 1 && names.some((name) => name.startsWith(`${candidate}/`)))
    ) {
      candidate = `${prefix}-${suffix}`;
      suffix += 1;
    }
    resolved = candidate;
  }
  return resolved;
}

// --- Messages ---------------------------------------------------------------------------------

/** First line the subject, the rest the body. */
export function parseCommitMessage(raw: string): { subject: string; body: string } | undefined {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return undefined;
  const [first = "", ...rest] = normalized.split("\n");
  return { subject: first.trim(), body: rest.join("\n").trim() };
}

/** A written subject: one line, no trailing period, at most 72 characters. */
export function sanitizeSubject(subject: string): string {
  const line = (subject.trim().split(/\r?\n/)[0] ?? "").trim().replace(/[.]+$/g, "").trim();
  return line.length > 0 ? line.slice(0, 72).trimEnd() : "Update project files";
}

const truncate = (value: string | undefined, max = 72) => {
  if (value === undefined) return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3).trimEnd()}...`;
};

const limit = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;

// --- Reading the repository -------------------------------------------------------------------

async function currentBranch(git: Git): Promise<string | null> {
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [0, 1, 128] });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function upstreamOf(git: Git): Promise<string | null> {
  const result = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    ok: [0, 128],
  });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function aheadBehind(git: Git, upstream: string): Promise<{ ahead: number; behind: number }> {
  const result = await git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  const [ahead = "0", behind = "0"] = result.stdout.trim().split(/\s+/);
  return { ahead: Number(ahead), behind: Number(behind) };
}

async function remotes(git: Git): Promise<string[]> {
  return (await git(["remote"])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function configValue(git: Git, key: string): Promise<string | undefined> {
  const result = await git(["config", "--get", key], { ok: [0, 1] });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

/** The remote and branch of an upstream such as `origin/feature/x` (the longest remote name wins). */
export function splitUpstream(
  upstream: string,
  names: readonly string[],
): { remote: string; branch: string } | undefined {
  const remote = names
    .filter((name) => upstream.startsWith(`${name}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  return remote === undefined ? undefined : { remote, branch: upstream.slice(remote.length + 1) };
}

/** Where a branch is pushed: `branch.<b>.pushRemote`, `remote.pushDefault`, `origin`, the first remote. */
async function pushRemoteOf(git: Git, branch: string): Promise<string | undefined> {
  const names = await remotes(git);
  for (const candidate of [
    await configValue(git, `branch.${branch}.pushRemote`),
    await configValue(git, "remote.pushDefault"),
  ]) {
    if (candidate !== undefined && names.includes(candidate)) return candidate;
  }
  return names.includes("origin") ? "origin" : names[0];
}

/** Whether `ref` exists as a commit. */
async function exists(git: Git, ref: string): Promise<boolean> {
  if (ref.startsWith("-")) return false;
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    ok: [0, 1, 128],
  });
  return result.code === 0;
}

interface Changes {
  /** `git diff --cached --stat` of what would be committed. */
  readonly summary: string;
  readonly patch: string;
}

/**
 * What a commit of every change (or of `paths`) would hold, read through a
 * temporary index so the user's own staging is untouched; `undefined` when
 * there is nothing to commit.
 */
async function readChanges(
  git: Git,
  gitDir: string,
  paths: readonly string[] | undefined,
): Promise<Changes | undefined> {
  const index = Path.join(gitDir, `jhin-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = (await exists(git, "HEAD")) ? "HEAD" : EMPTY_TREE;
    if (head === "HEAD") await git(["read-tree", "HEAD"], { env });
    await git(
      ["--literal-pathspecs", "add", "-A", "--", ...(paths === undefined ? ["."] : paths)],
      { env },
    );
    const names = await git(["diff", "--cached", "--name-only", head], { env });
    if (names.stdout.trim() === "") return undefined;
    const [stat, patch] = await Promise.all([
      git(["diff", "--cached", "--stat", head], { env, maxBytes: MAX_SUMMARY }),
      git(["diff", "--cached", "--no-color", "--no-ext-diff", head], { env, maxBytes: MAX_PATCH }),
    ]);
    return { summary: limit(stat.stdout, MAX_SUMMARY), patch: limit(patch.stdout, MAX_PATCH) };
  } finally {
    await Fs.rm(index, { force: true });
  }
}

// --- The action -------------------------------------------------------------------------------

const isCommitAction = (action: GitStackedAction) =>
  action === "commit" || action === "commit_push" || action === "commit_push_pr";

/**
 * Runs a stacked action: a feature branch (when asked), the commit, the push
 * and the pull request, each only when the action includes it; the first
 * failure ends it.
 */
export async function runStackedAction(run: ActionRun): Promise<Omit<GitActionResult, "actionId">> {
  const { git, action } = run;
  const terms = run.forge?.terminology ?? DEFAULT_TERMINOLOGY;
  const wantsCommit = isCommitAction(action);
  let branch = await currentBranch(git);
  let upstream = branch === null ? null : await upstreamOf(git);
  const counts = upstream === null ? { ahead: 0, behind: 0 } : await aheadBehind(git, upstream);
  const wantsPush =
    action === "push" ||
    action === "commit_push" ||
    action === "commit_push_pr" ||
    // A branch that follows another (`origin/main`) is not published under its own name yet.
    (action === "create_pr" &&
      (upstream === null ||
        counts.ahead > 0 ||
        splitUpstream(upstream, await remotes(git))?.branch !== branch));
  const wantsPr = action === "create_pr" || action === "commit_push_pr";
  if (run.featureBranch === true && !wantsCommit) {
    fail("Feature-branch checkout is only supported for commit actions.");
  }
  const phases: GitActionPhase[] = [
    ...(run.featureBranch === true ? (["branch"] as const) : []),
    ...(wantsCommit ? (["commit"] as const) : []),
    ...(wantsPush ? (["push"] as const) : []),
    ...(wantsPr ? (["pr"] as const) : []),
  ];
  run.progress({ kind: "action_started", phases });

  const result: Omit<GitActionResult, "actionId" | "toast"> = {
    action,
    branch: { status: "skipped_not_requested" },
    commit: { status: "skipped_not_requested" },
    push: { status: "skipped_not_requested" },
    pr: { status: "skipped_not_requested" },
  };
  let phase: GitActionPhase | null = null;
  /** The branch a feature branch was created from, to go back to when its commit fails. */
  let createdFrom: string | null | undefined;
  /** The commit was made: from then on nothing is undone, its branch holds it. */
  let committed = false;
  let partial = "";
  let hookLines = 0;
  const hookLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "" || hookLines >= MAX_HOOK_LINES) return;
    hookLines += 1;
    run.progress({
      kind: "hook_output",
      stream: "stderr",
      text: trimmed.slice(0, MAX_PROGRESS_TEXT),
    });
  };
  const enter = (next: GitActionPhase, label: string) => {
    phase = next;
    run.progress({ kind: "phase_started", phase: next, label });
  };

  try {
    if (run.featureBranch !== true && branch === null) {
      if (wantsPush) fail("Cannot push from detached HEAD.");
      if (wantsPr) fail(`Cannot create a ${terms.singular} from detached HEAD.`);
    }
    // Refused before anything is committed or pushed: the default branch has no base to target,
    // nor has a branch whose base would be itself (no default branch known).
    if (wantsPr && run.featureBranch !== true && branch !== null) {
      if (branch === run.defaultBranch) {
        fail(
          `Cannot create a ${terms.singular} from the default branch ${branch}: check out a feature branch first.`,
        );
      }
      if ((await baseBranchOf(git, branch, upstream, run.defaultBranch)) === branch) {
        fail(
          `Cannot create a ${terms.singular} into ${branch} from itself: set the repository's default branch (origin/HEAD) or the branch's base.`,
        );
      }
    }
    let suggestion: { subject: string; body: string } | undefined =
      run.commitMessage === undefined ? undefined : parseCommitMessage(run.commitMessage);

    if (run.featureBranch === true) {
      enter("branch", "Preparing feature branch...");
      const changes = await readChanges(git, run.gitDir, run.filePaths);
      if (changes === undefined) {
        fail("Cannot create a feature branch because there are no changes to commit.");
      }
      let preferred: string;
      if (suggestion === undefined) {
        const written = await run.writer.commitMessage({
          branch,
          summary: changes!.summary,
          patch: changes!.patch,
          includeBranch: true,
        });
        suggestion = { subject: sanitizeSubject(written.subject), body: written.body.trim() };
        preferred = written.branch ?? suggestion.subject;
      } else {
        preferred = suggestion.subject;
      }
      const locals = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout
        .split("\n")
        .filter((line) => line !== "");
      const name = resolveAutoFeatureBranchName(locals, preferred);
      await git(["switch", "--create", name]);
      createdFrom = branch;
      branch = name;
      upstream = null;
      result.branch = { status: "created", name };
    }

    if (wantsCommit) {
      phase = "commit";
      const changes = await readChanges(git, run.gitDir, run.filePaths);
      if (changes === undefined) {
        result.commit = { status: "skipped_no_changes" };
      } else {
        if (suggestion === undefined) {
          enter("commit", "Generating commit message...");
          const written = await run.writer.commitMessage({
            branch,
            summary: changes.summary,
            patch: changes.patch,
            includeBranch: false,
          });
          suggestion = { subject: sanitizeSubject(written.subject), body: written.body.trim() };
        }
        enter("commit", "Committing...");
        // Only these files: staged, then committed with `--only`, so whatever else the user
        // staged stays staged and out of the commit.
        const only = run.filePaths === undefined ? [] : ["--only", "--", ...run.filePaths];
        await git([
          "--literal-pathspecs",
          "add",
          "-A",
          "--",
          ...(run.filePaths === undefined ? ["."] : run.filePaths),
        ]);
        const message = [
          "-m",
          suggestion.subject,
          ...(suggestion.body ? ["-m", suggestion.body] : []),
        ];
        await git(["--literal-pathspecs", "commit", ...message, ...only], {
          timeoutMs: COMMIT_TIMEOUT_MS,
          // Hooks print to stderr (git hands their stdout there too); stdout is the commit's summary.
          onOutput: (stream, text) => {
            if (stream !== "stderr") return;
            // Output arrives in chunks: a line is published once it is whole.
            const lines = (partial + text).split(/\r?\n/);
            partial = lines.pop() ?? "";
            for (const line of lines) hookLine(line);
          },
        }).finally(() => {
          hookLine(partial);
          partial = "";
        });
        committed = true;
        const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
        result.commit = { status: "created", sha, subject: suggestion.subject };
      }
    }

    if (wantsPush && branch !== null) {
      enter("push", "Pushing...");
      result.push = await push(git, branch);
      if (result.push.status === "pushed") upstream = result.push.upstream ?? upstream;
    }

    if (wantsPr && branch !== null) {
      enter("pr", `Preparing ${terms.shortLabel}...`);
      const forge = run.forge;
      if (forge === undefined) {
        fail(`This repository's remote has no ${terms.singular} provider on this node.`);
      }
      upstream = await upstreamOf(git);
      if (upstream === null) {
        fail(`Current branch has not been pushed. Push before creating a ${terms.shortLabel}.`);
      }
      const existing = await forge!.find(branch);
      if (existing !== null && existing.state === "open") {
        result.pr = { status: "opened_existing", pullRequest: existing };
      } else {
        const base = await baseBranchOf(git, branch, upstream!, run.defaultBranch);
        // Without a known default branch the base may fall back to the branch itself.
        if (base === branch) {
          fail(
            `Cannot create a ${terms.singular} into ${branch} from itself: set the repository's default branch (origin/HEAD) or the branch's base.`,
          );
        }
        enter("pr", `Generating ${terms.shortLabel} content...`);
        const content = await pullRequestContent(git, run, base, branch);
        const bodyFile = Path.join(Os.tmpdir(), `jhin-pr-body-${process.pid}-${randomUUID()}.md`);
        await Fs.writeFile(bodyFile, content.body);
        try {
          enter("pr", `Creating ${terms.singular}...`);
          const created = await forge!.create({
            base,
            head: branch,
            title: content.title,
            bodyFile,
          });
          result.pr = { status: "created", pullRequest: created };
        } finally {
          await Fs.rm(bodyFile, { force: true });
        }
      }
    }
  } catch (error) {
    // A feature branch whose commit failed is undone: back on the branch it came from, the
    // changes still in the working tree.
    if (createdFrom !== undefined && !committed && branch !== null) {
      const created = branch;
      await git(createdFrom === null ? ["switch", "--detach", "HEAD@{1}"] : ["switch", createdFrom])
        .then(() => git(["branch", "-D", "--", created]))
        .catch(() => undefined);
    }
    run.progress({ kind: "action_failed", phase, message: (error as Error).message });
    throw error;
  }

  const isDefault = branch !== null && branch === run.defaultBranch;
  let openPr = result.pr.pullRequest;
  if (
    openPr === undefined &&
    run.forge !== undefined &&
    branch !== null &&
    !isDefault &&
    (action === "push" || action === "commit_push")
  ) {
    openPr = (await run.forge.find(branch).catch(() => null)) ?? undefined;
    if (openPr?.state !== "open") openPr = undefined;
  }
  const finished: Omit<GitActionResult, "actionId"> = {
    ...result,
    toast: {
      ...summarize(result, terms),
      cta: callToAction(result, terms, openPr, isDefault, run.forge !== undefined),
    },
  };
  run.progress({ kind: "action_finished", result: { ...finished, actionId: "" } });
  return finished;
}

/** Pushes `branch`: to its upstream when it has one of its own name, else to its push remote with `-u`. */
async function push(git: Git, branch: string): Promise<GitActionResult["push"]> {
  const names = await remotes(git);
  const upstream = await upstreamOf(git);
  if (upstream !== null) {
    const counts = await aheadBehind(git, upstream);
    const parts = splitUpstream(upstream, names);
    // Up to date only with an upstream of its own name; one that follows another is published.
    if (counts.ahead === 0 && counts.behind === 0 && parts?.branch === branch) {
      return { status: "skipped_up_to_date", branch, upstream };
    }
    if (parts !== undefined && parts.branch === branch) {
      await git(["push", "--", parts.remote, `HEAD:refs/heads/${branch}`], {
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      return { status: "pushed", branch, upstream };
    }
    // A branch cut from another (`origin/dev`) gets its own on the remote: its commits never
    // land on the shared one, and the pull request targets where it came from.
    if (
      parts !== undefined &&
      (await configValue(git, `branch.${branch}.gh-merge-base`)) === undefined
    ) {
      await git(["config", `branch.${branch}.gh-merge-base`, parts.branch]);
    }
  }
  const remote = await pushRemoteOf(git, branch);
  if (remote === undefined) {
    fail("Cannot push because no git remote is configured for this repository.");
  }
  if (upstream === null && (await exists(git, `${remote}/${branch}`))) {
    const contained = await git(["merge-base", "--is-ancestor", "HEAD", `${remote}/${branch}`], {
      ok: [0, 1],
    });
    if (contained.code === 0) {
      return { status: "skipped_up_to_date", branch, upstream: `${remote}/${branch}` };
    }
  }
  await git(["push", "-u", "--", remote!, `HEAD:refs/heads/${branch}`], {
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  return { status: "pushed", branch, upstream: `${remote}/${branch}`, setUpstream: true };
}

/**
 * Where a pull request of `branch` goes: `branch.<b>.gh-merge-base`, else the
 * upstream's branch when it is another one, else the default branch, else `main`.
 */
async function baseBranchOf(
  git: Git,
  branch: string,
  upstream: string | null,
  defaultBranch: string | null,
): Promise<string> {
  const configured = await configValue(git, `branch.${branch}.gh-merge-base`);
  if (configured !== undefined) return configured;
  const parts = upstream === null ? undefined : splitUpstream(upstream, await remotes(git));
  if (parts !== undefined && parts.branch !== branch) return parts.branch;
  return defaultBranch ?? "main";
}

async function pullRequestContent(
  git: Git,
  run: ActionRun,
  base: string,
  head: string,
): Promise<{ title: string; body: string }> {
  const remote = (await pushRemoteOf(git, head)) ?? "origin";
  const baseRef = (await exists(git, `${remote}/${base}`))
    ? `${remote}/${base}`
    : (await exists(git, base))
      ? base
      : undefined;
  const range = baseRef === undefined ? ["-n", "50", "HEAD"] : [`${baseRef}..HEAD`];
  const [commits, stat, patch] = await Promise.all([
    // Each commit ends in a record separator, its subject and body apart by a unit separator.
    git(["log", "--format=%s%x1f%b%x1e", ...range], { maxBytes: 12_000 }),
    baseRef === undefined
      ? Promise.resolve({ stdout: "" })
      : git(["diff", "--stat", `${baseRef}...HEAD`], { maxBytes: 12_000 }),
    baseRef === undefined
      ? Promise.resolve({ stdout: "" })
      : git(["diff", "--no-color", "--no-ext-diff", `${baseRef}...HEAD`], { maxBytes: 40_000 }),
  ]);
  const template =
    baseRef === undefined ? undefined : await run.forge?.template?.(baseRef).catch(() => undefined);
  const entries = commits.stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    });
  const written = await run.writer.pullRequest({
    base,
    head,
    commits: entries
      .map((entry) => (entry.body ? `${entry.subject}\n${entry.body}` : entry.subject))
      .join("\n\n"),
    subjects: entries.map((entry) => entry.subject),
    stat: stat.stdout,
    patch: patch.stdout,
    ...(template === undefined ? {} : { template }),
  });
  const title = written.title.trim().split("\n")[0]?.trim() || head;
  return { title, body: written.body.trim() };
}

/** The toast's title and description, as T3's summarizeGitActionResult words them. */
function summarize(
  result: Pick<GitActionResult, "commit" | "push" | "pr">,
  terms: ChangeRequestTerminology,
): { title: string; description?: string } {
  const describe = (title: string, description: string | undefined) => {
    const cut = truncate(description);
    return cut ? { title, description: cut } : { title };
  };
  const pr = result.pr.pullRequest;
  if (result.pr.status === "created" || result.pr.status === "opened_existing") {
    const verb = result.pr.status === "created" ? "Created" : "Opened";
    return describe(`${verb} ${terms.shortLabel}${pr ? ` #${pr.number}` : ""}`, pr?.title);
  }
  const sha = result.commit.sha?.slice(0, 7);
  if (result.push.status === "pushed") {
    const target = result.push.upstream ?? result.push.branch;
    return describe(
      `Pushed${sha ? ` ${sha}` : ""}${target ? ` to ${target}` : ""}`,
      result.commit.subject,
    );
  }
  if (result.commit.status === "created") {
    return describe(sha ? `Committed ${sha}` : "Committed changes", result.commit.subject);
  }
  return { title: "Done" };
}

function callToAction(
  result: Pick<GitActionResult, "action" | "commit" | "push" | "pr">,
  terms: ChangeRequestTerminology,
  openPr: PullRequest | undefined,
  isDefault: boolean,
  hasForge: boolean,
): GitActionCta {
  if (result.action === "commit" && result.commit.status === "created") {
    return { kind: "run_action", label: "Push", action: "push" };
  }
  if (
    result.action !== "commit" &&
    openPr !== undefined &&
    (!isDefault || result.pr.status === "created" || result.pr.status === "opened_existing")
  ) {
    return { kind: "open_pr", label: `View ${terms.shortLabel}`, url: openPr.url };
  }
  if (
    (result.action === "push" || result.action === "commit_push") &&
    result.push.status === "pushed" &&
    !isDefault &&
    hasForge
  ) {
    return { kind: "run_action", label: `Create ${terms.shortLabel}`, action: "create_pr" };
  }
  return { kind: "none" };
}

/** Pulls the checked-out branch from its upstream, fast-forward only (T3's `vcs.pull`). */
export async function pull(git: Git): Promise<PullResult> {
  const branch = await currentBranch(git);
  if (branch === null) fail("Cannot pull from detached HEAD.");
  const upstream = await upstreamOf(git);
  if (upstream === null) {
    fail("Current branch has no upstream configured. Push with upstream first.");
  }
  const before = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["pull", "--ff-only"], { timeoutMs: PULL_TIMEOUT_MS });
  const after = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return {
    status: before === after ? "skipped_up_to_date" : "pulled",
    branch: branch!,
    upstream,
  };
}

/** Commits on `HEAD` that `base` (or its copy on `origin`) lacks; `undefined` without a base. */
export async function aheadOfBase(git: Git, base: string | null): Promise<number | undefined> {
  if (base === null) return undefined;
  for (const candidate of [`origin/${base}`, base]) {
    if (!(await exists(git, candidate))) continue;
    const result = await git(["rev-list", "--count", `${candidate}..HEAD`], { ok: [0, 128] });
    if (result.code === 0) return Number(result.stdout.trim());
  }
  return undefined;
}
