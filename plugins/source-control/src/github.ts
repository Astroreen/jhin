// Pull requests through the GitHub CLI, as T3 Code's source-control-github
// reads them (MIT, see THIRD_PARTY_NOTICES.md): `gh pr list --head <branch>`
// for a branch's pull request, `gh pr list --search` for a repository's (its
// GitHubPullRequestProvider: any state, most recently updated first), and the check rollup of
// gitHubPullRequestJson.ts (toCheckStatus, rollupChecksState).
import type { PullRequest, PullRequestChecks } from "@jhin/source-control-api";

import {
  ForgeUnavailable,
  PULL_REQUEST,
  matchesHead,
  viewerOf,
  type CheckoutTarget,
  type Forge,
  type ForgePullRequest,
  type HeadContext,
  type Viewers,
} from "./forge.ts";
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
  "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergedAt,closedAt,statusCheckRollup";
/** A listed pull request: no checks, which would make a long list slow to read. */
const LIST_FIELDS =
  "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergedAt,closedAt";
/** What tells a fork's pull request apart from one of this repository (D277). */
const HEAD_FIELDS = `${FIELDS},isCrossRepository,headRepositoryOwner`;

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
const GitHubUnavailable = ForgeUnavailable;

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
  readonly headRefOid?: unknown;
  readonly baseRefName?: unknown;
  readonly updatedAt?: unknown;
  readonly mergedAt?: unknown;
  readonly closedAt?: unknown;
  readonly statusCheckRollup?: readonly RawCheck[] | null;
  readonly isCrossRepository?: unknown;
  readonly headRepositoryOwner?: { readonly login?: unknown } | null;
  readonly headRepository?: { readonly name?: unknown } | null;
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
    ...(typeof raw.headRefOid === "string" && raw.headRefOid !== ""
      ? { headSha: raw.headRefOid }
      : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    // gh gives an open pull request the zero time (0001-01-01): only a closed one has times.
    ...(state !== "open" &&
    typeof raw.mergedAt === "string" &&
    Date.parse(raw.mergedAt) > Date.parse("1970-01-01T00:00:00Z")
      ? { mergedAt: raw.mergedAt }
      : {}),
    ...(state !== "open" &&
    typeof raw.closedAt === "string" &&
    Date.parse(raw.closedAt) > Date.parse("1970-01-01T00:00:00Z")
      ? { closedAt: raw.closedAt }
      : {}),
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
 * The newest pull request whose head is `head`'s branch, any state, or
 * `null`: of this repository's branch, or of the fork `head.owner` names
 * (`gh pr list --head` matches the branch name alone, so a same-named branch
 * of another fork is filtered out). Throws `GitHubUnavailable` when `gh` is
 * missing, signed out or fails.
 */
async function pullRequestFor(
  ghPath: string,
  cwd: string,
  head: string | HeadContext,
): Promise<PullRequest | null> {
  const context = typeof head === "string" ? { branch: head } : head;
  const parsed = await ghJson(ghPath, cwd, [
    "pr",
    "list",
    "--head",
    context.branch,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    HEAD_FIELDS,
  ]);
  if (!Array.isArray(parsed)) throw new GitHubUnavailable("failed", "gh answered no list");
  for (const raw of parsed as RawPullRequest[]) {
    const pr = toPullRequest(raw);
    if (pr === undefined) continue;
    const owner = raw.headRepositoryOwner?.login;
    const found: ForgePullRequest = {
      pr,
      ...(typeof raw.isCrossRepository === "boolean"
        ? { crossRepository: raw.isCrossRepository }
        : {}),
      ...(typeof owner === "string" ? { headOwner: owner } : {}),
    };
    if (matchesHead(found, context)) return pr;
  }
  return null;
}

/** A pull request by its URL (`gh pr view <url>`), whichever repository it is in. */
async function pullRequestAt(ghPath: string, cwd: string, url: string): Promise<PullRequest> {
  const parsed = await ghJson(ghPath, cwd, ["pr", "view", url, "--json", FIELDS]);
  const pr = toPullRequest((parsed ?? {}) as RawPullRequest);
  if (pr === undefined) throw new GitHubUnavailable("failed", "gh answered no pull request");
  return pr;
}

/**
 * A pull request by number, URL or head branch (`gh pr view <reference>`),
 * with where its head lives (T3's `getChangeRequest`, D902).
 */
async function checkoutTarget(
  ghPath: string,
  cwd: string,
  reference: string,
): Promise<CheckoutTarget> {
  const raw = ((await ghJson(ghPath, cwd, [
    "pr",
    "view",
    "--json",
    `${HEAD_FIELDS},headRepository`,
    "--",
    reference,
  ])) ?? {}) as RawPullRequest;
  const pr = toPullRequest(raw);
  if (pr === undefined) throw new GitHubUnavailable("failed", "gh answered no pull request");
  const owner = text(raw.headRepositoryOwner?.login);
  const name = text(raw.headRepository?.name);
  const crossRepository = raw.isCrossRepository === true;
  return {
    pr,
    crossRepository,
    pullRefs: true,
    ...(owner === undefined ? {} : { headOwner: owner }),
    ...(crossRepository && owner !== undefined && name !== undefined
      ? { headRepository: `${owner}/${name}` }
      : {}),
  };
}

/** A search query without qualifiers that would reach past the project's repository. */
export function withoutScopeQualifiers(query: string): string {
  // Wherever it stands: inside parentheses, quotes or after NOT, a qualifier still applies.
  const scope = /(?<![\p{L}\p{N}_-])-?(?:repo|org|user|owner):("[^"]*"?|\S*)/giu;
  if (query.search(scope) === -1) return query.replace(/\s+/g, " ").trim();
  // The operators and groups around a removed qualifier would dangle: such a query keeps
  // only its plain words.
  return query
    .replace(scope, " ")
    .replace(/[()]/g, " ")
    .replace(/(?<![\p{L}\p{N}_-])(?:AND|OR|NOT)(?![\p{L}\p{N}_-])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The repository's pull requests (`gh pr list --search`), any state, most
 * recently updated first; `query` is GitHub's search, as T3 searches on the host. Its
 * qualifiers (`is:`, `author:`) pass through, as in T3, but not those that name a scope
 * (`repo:`, `org:`, `user:`): GitHub would add their repositories to the project's.
 */
async function listPullRequests(
  ghPath: string,
  cwd: string,
  input: { readonly query?: string; readonly limit: number },
): Promise<PullRequest[]> {
  const query = withoutScopeQualifiers(input.query ?? "");
  const parsed = await ghJson(ghPath, cwd, [
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    String(input.limit),
    "--search",
    query === "" ? "sort:updated-desc" : `${query} sort:updated-desc`,
    "--json",
    LIST_FIELDS,
  ]);
  if (!Array.isArray(parsed)) throw new GitHubUnavailable("failed", "gh answered no list");
  return (parsed as RawPullRequest[])
    .map(toPullRequest)
    .filter((pr): pr is PullRequest => pr !== undefined);
}

/** Where GitHub looks for a pull request template, as T3's source-control-github reads it. */
const GITHUB_TEMPLATE_PATHS = [
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
async function createPullRequest(
  ghPath: string,
  cwd: string,
  input: { base: string; head: string | HeadContext; title: string; bodyFile: string },
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
        // A fork's branch is named with its owner (T3's `owner:branch` head selector).
        typeof input.head === "string"
          ? input.head
          : input.head.owner === undefined
            ? input.head.branch
            : `${input.head.owner}:${input.head.branch}`,
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
  const headBranch = typeof input.head === "string" ? input.head : input.head.branch;
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
    headBranch,
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

/** The host of a pull request's URL. */
const hostOf = (url: string) =>
  /^https?:\/\/([^/:]+)/i.exec(url)?.[1]?.toLowerCase() ?? "github.com";

/** The node's GitHub account (`gh api user`), per host: github.com and an Enterprise host may differ. */
const githubViewer = (viewers: Viewers, ghPath: string, cwd: string, host: string) =>
  viewerOf(viewers, `${ghPath}\u0000${host}`, () =>
    ghJson(ghPath, cwd, ["api", "--hostname", host, "user"]).then(
      (answer) => text((answer as RawActor | null)?.login) ?? null,
    ),
  );

const WATCH_FIELDS =
  "number,url,state,headRefOid,mergeable,baseRefName,statusCheckRollup,comments,reviews,author";

/**
 * The names of the checks the base branch requires (`gh pr checks --required`,
 * T3's `isRequired`, D908), or undefined when `gh` could not say; then no check
 * is marked and every check is the gate. Its JSON answers whatever it exits with
 * (8 while checks are pending, 1 when one failed).
 */
async function requiredChecks(
  ghPath: string,
  cwd: string,
  url: string,
): Promise<Set<string> | undefined> {
  let result;
  try {
    result = await run(ghPath, ["pr", "checks", url, "--required", "--json", "name"], {
      cwd,
      env: GH_ENV,
      timeoutMs: GH_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  const out = result.stdout.trim();
  // Nothing on stdout: gh says on stderr that the branch requires no checks, or why it failed.
  if (out === "") return /no required checks/i.test(result.stderr) ? new Set() : undefined;
  try {
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) return undefined;
    return new Set(
      parsed
        .map((item) => text((item as { name?: unknown }).name))
        .filter((name) => name !== undefined),
    );
  } catch {
    return undefined;
  }
}

/** What a watch reads of a pull request (D272): checks, mergeability and remarks. */
async function readWatch(
  ghPath: string,
  cwd: string,
  url: string,
  viewers: Viewers,
): Promise<WatchRead> {
  const [answer, viewer, required] = await Promise.all([
    ghJson(ghPath, cwd, ["pr", "view", url, "--json", WATCH_FIELDS]),
    githubViewer(viewers, ghPath, cwd, hostOf(url)),
    requiredChecks(ghPath, cwd, url),
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
    requiredKnown: required !== undefined,
    checks: rollup.map((check) => {
      const link = text(check.detailsUrl) ?? text(check.targetUrl);
      return {
        name: check.name ?? check.context ?? "check",
        status: checkStatus(check),
        ...(link ? { url: link } : {}),
        ...(required === undefined
          ? {}
          : { required: required.has(check.name ?? check.context ?? "check") }),
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

/** GitHub and GitHub Enterprise through `gh`, which picks the host from the repository or URL. */
export function githubForge(ghPath: () => string, cwd: string, viewers: Viewers): Forge {
  return {
    kind: "github",
    name: "GitHub",
    terminology: PULL_REQUEST,
    find: (head) => pullRequestFor(ghPath(), cwd, head),
    at: (url) => pullRequestAt(ghPath(), cwd, url),
    resolve: (reference) => checkoutTarget(ghPath(), cwd, reference),
    list: (input) => listPullRequests(ghPath(), cwd, input),
    create: (input) => createPullRequest(ghPath(), cwd, input),
    templatePaths: GITHUB_TEMPLATE_PATHS,
    watch: (url) => readWatch(ghPath(), cwd, url, viewers),
  };
}
