// Pull requests through the GitHub CLI, as T3 Code's source-control-github
// reads them (MIT, see THIRD_PARTY_NOTICES.md): `gh pr list --head <branch>`
// for a branch's pull request, and the check rollup of
// gitHubPullRequestJson.ts (toCheckStatus, rollupChecksState).
import type { PullRequest, PullRequestChecks } from "@jhin/source-control-api";

import { run, SpawnError } from "./git.ts";

const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};
const GH_TIMEOUT_MS = 20_000;
const FIELDS = "number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,statusCheckRollup";

/** The host of a remote URL (`https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://…`). */
export function remoteHost(url: string): string | undefined {
  const scp = /^[^@/]+@([^:/]+):/.exec(url);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Why `gh` could not answer: missing, signed out, or another failure. */
export class GitHubUnavailable extends Error {
  readonly kind: "missing" | "signed-out" | "failed";
  constructor(kind: "missing" | "signed-out" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

type CheckStatus =
  | "success"
  | "failure"
  | "cancelled"
  | "pending"
  | "action-required"
  | "skipped"
  | "neutral";

interface RawCheck {
  readonly name?: string | null;
  readonly context?: string | null;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly state?: string | null;
}

/** A check run reports `status` and, once completed, a `conclusion`; a commit status a `state`. */
function checkStatus(raw: RawCheck): CheckStatus {
  const status = raw.status?.trim().toUpperCase();
  if (status !== undefined && status !== "COMPLETED" && status !== "") return "pending";
  switch ((raw.conclusion ?? raw.state)?.trim().toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "ACTION_REQUIRED":
      return "action-required";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "neutral";
  }
}

export function rollupChecks(raw: readonly RawCheck[] | null | undefined): PullRequestChecks {
  const statuses = (raw ?? []).map(checkStatus);
  const count = (...kinds: CheckStatus[]) =>
    statuses.filter((status) => kinds.includes(status)).length;
  const failed = count("failure", "cancelled");
  const pending = count("pending", "action-required");
  const passed = count("success");
  return {
    state: failed > 0 ? "failing" : pending > 0 ? "pending" : passed > 0 ? "passing" : null,
    passed,
    failed,
    pending,
    total: statuses.length,
  };
}

interface RawPullRequest {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly url?: unknown;
  readonly state?: unknown;
  readonly isDraft?: unknown;
  readonly headRefName?: unknown;
  readonly baseRefName?: unknown;
  readonly updatedAt?: unknown;
  readonly statusCheckRollup?: readonly RawCheck[] | null;
}

function toPullRequest(raw: RawPullRequest): PullRequest | undefined {
  const state = typeof raw.state === "string" ? raw.state.toLowerCase() : "";
  if (
    typeof raw.number !== "number" ||
    typeof raw.url !== "string" ||
    (state !== "open" && state !== "closed" && state !== "merged")
  ) {
    return undefined;
  }
  return {
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : `#${raw.number}`,
    url: raw.url,
    state,
    isDraft: raw.isDraft === true,
    headBranch: typeof raw.headRefName === "string" ? raw.headRefName : "",
    baseBranch: typeof raw.baseRefName === "string" ? raw.baseRefName : "",
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    checks: rollupChecks(Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []),
  };
}

const SIGNED_OUT = /gh auth login|not logged in|authentication|GH_TOKEN/i;

/**
 * The newest pull request whose head is `branch`, any state, or `null`.
 * Throws `GitHubUnavailable` when `gh` is missing, signed out or fails.
 */
export async function pullRequestFor(
  ghPath: string,
  cwd: string,
  branch: string,
): Promise<PullRequest | null> {
  let result;
  try {
    result = await run(
      ghPath,
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", FIELDS],
      { cwd, env: GH_ENV, timeoutMs: GH_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof SpawnError && (error.code === "ENOENT" || error.code === "EACCES")) {
      throw new GitHubUnavailable("missing", "GitHub CLI (gh) is not installed on this node");
    }
    throw new GitHubUnavailable("failed", (error as Error).message);
  }
  if (result.code !== 0) {
    const message = result.stderr.trim().split("\n")[0] ?? "";
    if (result.code === 4 || SIGNED_OUT.test(result.stderr)) {
      throw new GitHubUnavailable(
        "signed-out",
        "GitHub CLI is not signed in: run `gh auth login` on this node",
      );
    }
    throw new GitHubUnavailable("failed", message || `gh exited with code ${result.code}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new GitHubUnavailable("failed", "gh answered something that is not JSON");
  }
  if (!Array.isArray(parsed)) throw new GitHubUnavailable("failed", "gh answered no list");
  const first = parsed[0] as RawPullRequest | undefined;
  return first === undefined ? null : (toPullRequest(first) ?? null);
}

/** Where GitHub looks for a pull request template, as T3's source-control-github reads it. */
export const GITHUB_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];

/**
 * Opens a pull request of `head` into `base` with `gh pr create` and reads it
 * back. Throws `GitHubUnavailable` when `gh` is missing or signed out, and
 * an `Error` with `gh`'s own message when GitHub refuses.
 */
export async function createPullRequest(
  ghPath: string,
  cwd: string,
  input: { base: string; head: string; title: string; bodyFile: string },
): Promise<PullRequest> {
  let result;
  try {
    result = await run(
      ghPath,
      [
        "pr",
        "create",
        "--base",
        input.base,
        "--head",
        input.head,
        "--title",
        input.title,
        "--body-file",
        input.bodyFile,
      ],
      { cwd, env: GH_ENV, timeoutMs: 60_000 },
    );
  } catch (error) {
    if (error instanceof SpawnError && (error.code === "ENOENT" || error.code === "EACCES")) {
      throw new GitHubUnavailable("missing", "GitHub CLI (gh) is not installed on this node");
    }
    throw error;
  }
  if (result.code !== 0) {
    if (result.code === 4 || SIGNED_OUT.test(result.stderr)) {
      throw new GitHubUnavailable(
        "signed-out",
        "GitHub CLI is not signed in: run `gh auth login` on this node",
      );
    }
    const message = result.stderr
      .trim()
      .split("\n")
      .find((line) => line.trim() !== "");
    throw new Error(message ?? `gh pr create exited with code ${result.code}`);
  }
  const created = await pullRequestFor(ghPath, cwd, input.head);
  if (created !== null) return created;
  const url = result.stdout.trim().split("\n").at(-1) ?? "";
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? Number.NaN);
  if (!Number.isInteger(number)) throw new Error("gh created a pull request it cannot find");
  return {
    number,
    title: input.title,
    url,
    state: "open",
    isDraft: false,
    headBranch: input.head,
    baseBranch: input.base,
    checks: rollupChecks([]),
  };
}
