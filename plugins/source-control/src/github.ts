// Pull requests through the GitHub CLI, as T3 Code's source-control-github
// reads them (MIT, see THIRD_PARTY_NOTICES.md): `gh pr list --head <branch>`
// for a branch's pull request, and the check rollup of
// gitHubPullRequestJson.ts (toCheckStatus, rollupChecksState).
import type { PullRequest, PullRequestChecks } from "@jhin/source-control-api";

import { run, SpawnError } from "./git.ts";
import type { Remark, WatchRead } from "./pr-watch.ts";

const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};
const GH_TIMEOUT_MS = 20_000;
const FIELDS =
  "number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,mergedAt,closedAt,statusCheckRollup";

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
  readonly mergedAt?: unknown;
  readonly closedAt?: unknown;
  readonly statusCheckRollup?: readonly RawCheck[] | null;
}

function toPullRequest(raw: RawPullRequest): PullRequest | undefined {
  const state = typeof raw.state === "string" ? raw.state.toLowerCase() : "";
  if (
    typeof raw.number !== "number" ||
    typeof raw.url !== "string" ||
    !/^https?:\/\//i.test(raw.url) ||
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
    ...(typeof raw.mergedAt === "string" && raw.mergedAt !== "" ? { mergedAt: raw.mergedAt } : {}),
    ...(typeof raw.closedAt === "string" && raw.closedAt !== "" ? { closedAt: raw.closedAt } : {}),
    checks: rollupChecks(Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []),
  };
}

const SIGNED_OUT = /gh auth login|not logged in|authentication|GH_TOKEN/i;

/** Runs `gh` and parses its JSON answer; throws `GitHubUnavailable` when it cannot answer. */
async function ghJson(ghPath: string, cwd: string, args: readonly string[]): Promise<unknown> {
  let result;
  try {
    result = await run(ghPath, args, { cwd, env: GH_ENV, timeoutMs: GH_TIMEOUT_MS });
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
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GitHubUnavailable("failed", "gh answered something that is not JSON");
  }
}

/**
 * The newest pull request whose head is `branch`, any state, or `null`.
 * Throws `GitHubUnavailable` when `gh` is missing, signed out or fails.
 */
export async function pullRequestFor(
  ghPath: string,
  cwd: string,
  branch: string,
): Promise<PullRequest | null> {
  const parsed = await ghJson(ghPath, cwd, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "1",
    "--json",
    FIELDS,
  ]);
  if (!Array.isArray(parsed)) throw new GitHubUnavailable("failed", "gh answered no list");
  const first = parsed[0] as RawPullRequest | undefined;
  return first === undefined ? null : (toPullRequest(first) ?? null);
}

/** A pull request by its URL (`gh pr view <url>`), whichever repository it is in. */
export async function pullRequestAt(
  ghPath: string,
  cwd: string,
  url: string,
): Promise<PullRequest> {
  const parsed = await ghJson(ghPath, cwd, ["pr", "view", url, "--json", FIELDS]);
  const pr = toPullRequest((parsed ?? {}) as RawPullRequest);
  if (pr === undefined) throw new GitHubUnavailable("failed", "gh answered no pull request");
  return pr;
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

interface RawActor {
  readonly login?: unknown;
}

interface RawRemark {
  readonly id?: unknown;
  readonly author?: RawActor | null;
  readonly body?: unknown;
  readonly createdAt?: unknown;
  readonly submittedAt?: unknown;
  readonly lastEditedAt?: unknown;
  readonly state?: unknown;
  readonly url?: unknown;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const login = (actor: RawActor | null | undefined) => text(actor?.login) ?? null;

/** How long the node's GitHub account is taken as known: a `gh auth switch` shows within it. */
const VIEWER_TTL_MS = 10 * 60_000;

/** The plugin's answers of `gh api user`, by `gh`; kept by whoever reads watches. */
export type Viewers = Map<string, { readonly at: number; readonly login: Promise<string | null> }>;

/** The node's GitHub account (`gh api user`), asked again once its answer is old. */
function viewerOf(viewers: Viewers, ghPath: string, cwd: string): Promise<string | null> {
  const known = viewers.get(ghPath);
  if (known !== undefined && Date.now() - known.at < VIEWER_TTL_MS) return known.login;
  const asked = ghJson(ghPath, cwd, ["api", "user"]).then(
    (answer) => text((answer as RawActor | null)?.login) ?? null,
    () => null,
  );
  viewers.set(ghPath, { at: Date.now(), login: asked });
  // A failed answer is asked again next time.
  void asked.then((value) => {
    if (value === null && viewers.get(ghPath)?.login === asked) viewers.delete(ghPath);
  });
  return asked;
}

const WATCH_FIELDS =
  "number,url,state,headRefOid,mergeable,baseRefName,statusCheckRollup,comments,reviews,author";

/** What a watch reads of a pull request (D272): checks, mergeability and remarks. */
export async function readWatch(
  ghPath: string,
  cwd: string,
  url: string,
  viewers: Viewers,
): Promise<WatchRead> {
  const [answer, viewer] = await Promise.all([
    ghJson(ghPath, cwd, ["pr", "view", url, "--json", WATCH_FIELDS]),
    viewerOf(viewers, ghPath, cwd),
  ]);
  const raw = (answer ?? {}) as Record<string, unknown>;
  const state = text(raw["state"])?.toLowerCase();
  const rollup = Array.isArray(raw["statusCheckRollup"])
    ? (raw["statusCheckRollup"] as (RawCheck & { detailsUrl?: unknown; targetUrl?: unknown })[])
    : [];
  const remark = (item: RawRemark, review: boolean): Remark | undefined => {
    const id = text(item.id);
    const createdAt = text(item.createdAt) ?? text(item.submittedAt);
    if (id === undefined || createdAt === undefined) return undefined;
    const edited = text(item.lastEditedAt);
    const link = text(item.url);
    const reviewState = review ? text(item.state) : undefined;
    return {
      id,
      author: login(item.author),
      body: text(item.body) ?? "",
      createdAt,
      ...(edited ? { editedAt: edited } : {}),
      ...(link ? { url: link } : {}),
      ...(reviewState ? { reviewState } : {}),
    };
  };
  const list = (key: string) =>
    Array.isArray(raw[key]) ? (raw[key] as RawRemark[]) : ([] as RawRemark[]);
  const mergeable = text(raw["mergeable"])?.toUpperCase();
  return {
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    headSha: text(raw["headRefOid"]) ?? null,
    baseBranch: text(raw["baseRefName"]) ?? "",
    checks: rollup.map((check) => {
      const link = text(check.detailsUrl) ?? text(check.targetUrl);
      return {
        name: check.name ?? check.context ?? "check",
        status: checkStatus(check),
        ...(link ? { url: link } : {}),
      };
    }),
    mergeability:
      mergeable === "MERGEABLE"
        ? "mergeable"
        : mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    author: login(raw["author"] as RawActor | null),
    viewer,
    remarks: [
      ...list("comments").map((item) => remark(item, false)),
      ...list("reviews").map((item) => remark(item, true)),
    ].filter((item): item is Remark => item !== undefined),
  };
}
