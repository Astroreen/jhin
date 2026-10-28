// Pull requests through the GitHub CLI, as T3 Code's source-control-github
// reads them (MIT, see THIRD_PARTY_NOTICES.md): `gh pr list --head <branch>`
// for a branch's pull request, `gh pr list --search` for a repository's (its
// GitHubPullRequestProvider: any state, most recently updated first), and the check rollup of
// gitHubPullRequestJson.ts (toCheckStatus, rollupChecksState, the review decision and
// mergeability), pullRequestReviews.graphql (review threads, D1447) and pullRequestReads.graphql
// (the repository's merge methods, PullRequestActionState). T3 sends its actions as GraphQL
// mutations; Jhin runs the `gh pr merge|ready|close|reopen` that send them (D1451) and T3's
// own mutations and REST calls through `gh api` for the others (GitHubPullRequestApi.ts's
// runPullRequestAction, D1661, D1662); an author's avatar is T3's loginAvatarUrl (D1665).
import {
  parsePullRequestUrl,
  type PullRequest,
  type PullRequestCheck,
  type PullRequestChecks,
  type PullRequestAction,
  type PullRequestMergeMethod,
  type PullRequestUpdateMethod,
} from "@jhin/source-control-api";

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
  "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergedAt,closedAt,statusCheckRollup,author,additions,deletions,changedFiles,reviewDecision,mergeable,autoMergeRequest";
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
  readonly description?: string | null;
  readonly detailsUrl?: string | null;
  readonly targetUrl?: string | null;
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
  readonly author?: { readonly login?: unknown; readonly name?: unknown } | null;
  readonly additions?: unknown;
  readonly deletions?: unknown;
  readonly changedFiles?: unknown;
  readonly reviewDecision?: unknown;
  readonly mergeable?: unknown;
  readonly autoMergeRequest?: unknown;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** T3's review decision of GitHub's words. */
function reviewDecisionOf(value: unknown): PullRequest["reviewDecision"] {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return undefined;
  }
}

/** T3's mergeability of GitHub's `mergeable`. */
function mergeabilityOf(value: unknown): PullRequest["mergeability"] {
  const word = typeof value === "string" ? value.toUpperCase() : "";
  return word === "MERGEABLE" ? "mergeable" : word === "CONFLICTING" ? "conflicting" : "unknown";
}

/**
 * T3's loginAvatarUrl (D1665): `gh pr view` names no avatar, and GitHub serves one at
 * `<host>/<login>.png` for every login (a bot's `app/…` login is none).
 */
export function loginAvatarUrl(login: string, host: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,38}$/iu.test(login) ? `https://${host}/${login}.png?size=80` : null;
}

/** The row details of D1449, where `gh` told them. */
function detailsOf(raw: RawPullRequest): Partial<PullRequest> {
  const login = typeof raw.author?.login === "string" ? raw.author.login : undefined;
  const name =
    typeof raw.author?.name === "string" && raw.author.name !== "" ? raw.author.name : null;
  const avatarUrl =
    login === undefined || typeof raw.url !== "string"
      ? null
      : loginAvatarUrl(login, hostOf(raw.url));
  const additions = count(raw.additions);
  const deletions = count(raw.deletions);
  const changedFiles = count(raw.changedFiles);
  const reviewDecision = reviewDecisionOf(raw.reviewDecision);
  return {
    ...(login === undefined ? {} : { author: { login, name, avatarUrl } }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    ...(raw.mergeable === undefined ? {} : { mergeability: mergeabilityOf(raw.mergeable) }),
    // `null` while none is armed (D1661).
    ...(raw.autoMergeRequest === undefined ? {} : { autoMerge: raw.autoMergeRequest !== null }),
  };
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
    ...detailsOf(raw),
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
  const [answer, viewer, required, threads] = await Promise.all([
    ghJson(ghPath, cwd, ["pr", "view", url, "--json", WATCH_FIELDS]),
    githubViewer(viewers, ghPath, cwd, hostOf(url)),
    requiredChecks(ghPath, cwd, url),
    reviewThreadRemarks(ghPath, cwd, url),
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
    // A review thread's comment is told once, by its id (D1447).
    remarks: [
      ...list("comments").map((item) => remark(item, false)),
      ...list("reviews").map((item) => remark(item, true)),
      ...threads,
    ]
      .filter((item): item is Remark => item !== undefined)
      .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index),
  };
}

/** The review threads' comments on lines (D1447): `gh pr view` has none, GraphQL has them. */
const REVIEW_THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          path
          comments(first: 100) {
            nodes { id author { login } body createdAt lastEditedAt url }
          }
        }
      }
    }
  }
}`;

/** The comments of a pull request's review threads, each with its file; none when unread. */
async function reviewThreadRemarks(ghPath: string, cwd: string, url: string): Promise<Remark[]> {
  const parsed = parsePullRequestUrl(url);
  const [owner, name] = parsed?.repository.split("/") ?? [];
  if (parsed === undefined || owner === undefined || name === undefined) return [];
  const answer = (await ghJson(ghPath, cwd, [
    "api",
    "graphql",
    "--hostname",
    parsed.host,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${parsed.number}`,
    "-f",
    `query=${REVIEW_THREADS}`,
  ]).catch(() => undefined)) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: { path?: unknown; comments?: { nodes?: RawRemark[] } }[];
          };
        };
      };
    };
  };
  const threads = answer?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return threads.flatMap((thread) => {
    const path = text(thread.path);
    return (thread.comments?.nodes ?? []).flatMap((item): Remark[] => {
      const id = text(item.id);
      const createdAt = text(item.createdAt);
      if (id === undefined || createdAt === undefined) return [];
      const edited = text(item.lastEditedAt);
      const link = text(item.url);
      return [
        {
          id,
          author: login(item.author),
          body: text(item.body) ?? "",
          createdAt,
          ...(edited ? { editedAt: edited } : {}),
          ...(path ? { path } : {}),
          ...(link ? { url: link } : {}),
        },
      ];
    });
  });
}

/** The head's checks one by one (D1450), required ones marked as D908 reads them. */
async function checksOf(ghPath: string, cwd: string, url: string): Promise<PullRequestCheck[]> {
  const [answer, required] = await Promise.all([
    ghJson(ghPath, cwd, ["pr", "view", url, "--json", "statusCheckRollup"]),
    requiredChecks(ghPath, cwd, url),
  ]);
  const rollup = (answer as { statusCheckRollup?: RawCheck[] | null } | null)?.statusCheckRollup;
  return (Array.isArray(rollup) ? rollup : []).map((check) => {
    const name = check.name ?? check.context ?? "check";
    return {
      name,
      status: checkStatus(check),
      description: check.description || null,
      url: check.detailsUrl || check.targetUrl || null,
      ...(required === undefined ? {} : { required: required.has(name) }),
    };
  });
}

/** The merge methods the repository allows (T3's `mergeCommitAllowed`, … of GraphQL). */
async function mergeMethodsOf(
  ghPath: string,
  cwd: string,
  url: string,
): Promise<PullRequestMergeMethod[]> {
  const parsed = parsePullRequestUrl(url);
  if (parsed === undefined) throw new GitHubUnavailable("failed", `${url} is no pull request URL`);
  const answer = (await ghJson(ghPath, cwd, [
    "repo",
    "view",
    `${parsed.host}/${parsed.repository}`,
    "--json",
    "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
  ])) as Record<string, unknown> | null;
  return [
    ...(answer?.["mergeCommitAllowed"] === true ? (["merge"] as const) : []),
    ...(answer?.["squashMergeAllowed"] === true ? (["squash"] as const) : []),
    ...(answer?.["rebaseMergeAllowed"] === true ? (["rebase"] as const) : []),
  ];
}

/** Runs a `gh` command that answers no JSON; its first line of error when it fails. */
async function ghRun(ghPath: string, cwd: string, args: readonly string[]): Promise<void> {
  let result;
  try {
    result = await run(ghPath, args, { cwd, env: GH_ENV, timeoutMs: 60_000 });
  } catch (error) {
    if (error instanceof SpawnError && (error.code === "ENOENT" || error.code === "EACCES")) {
      throw new GitHubUnavailable("missing", "GitHub CLI (gh) is not installed on this node");
    }
    throw new GitHubUnavailable("failed", (error as Error).message);
  }
  if (result.code === 0) return;
  if (result.code === 4 || SIGNED_OUT.test(result.stderr)) {
    throw new GitHubUnavailable(
      "signed-out",
      "GitHub CLI is not signed in: run `gh auth login` on this node",
    );
  }
  const line = result.stderr
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "");
  throw new GitHubUnavailable("failed", line ?? `gh exited with code ${result.code}`);
}

/** T3's PullRequestActionState, with what deleting the head branch and approving runs need. */
const ACTION_STATE = `query($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id state headRefOid headRefName baseRefName isCrossRepository isMergeQueueEnabled mergeStateStatus
      headRepositoryOwner { login }
      headRepository { id nameWithOwner defaultBranchRef { name } }
      headRef { target { oid } }
      baseRef { compare(headRef: $headRef) { behindBy } }
    }
  }
}`;

/** T3's mutations that need the pull request's node id alone. */
const SIMPLE_MUTATIONS: Partial<Record<PullRequestAction, string>> = {
  draft: "convertPullRequestToDraft",
  "disable-auto-merge": "disablePullRequestAutoMerge",
  revert: "revertPullRequest",
};
const ENABLE_AUTO_MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId }
}`;
const UPDATE_BRANCH = `mutation($id: ID!, $head: GitObjectID!, $method: PullRequestBranchUpdateMethod!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: $method }) { clientMutationId }
}`;
const DELETE_BRANCH = `mutation($repository: ID!, $ref: GitRefname!, $before: GitObjectID!) {
  updateRefs(input: { repositoryId: $repository, refUpdates: [{ name: $ref, beforeOid: $before, afterOid: "0000000000000000000000000000000000000000" }] }) { clientMutationId }
}`;
/** T3's merge state statuses in which GitHub merges at once rather than arming auto-merge. */
const IMMEDIATELY_MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const GRAPHQL_MERGE_METHODS: Record<PullRequestMergeMethod, string> = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
};

interface ActionState {
  readonly id: string;
  readonly state?: string;
  readonly headRefOid?: string;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly isCrossRepository?: boolean;
  readonly isMergeQueueEnabled?: boolean;
  readonly mergeStateStatus?: string;
  readonly headRepositoryOwner?: { readonly login?: string } | null;
  readonly headRepository?: {
    readonly id?: string;
    readonly nameWithOwner?: string;
    readonly defaultBranchRef?: { readonly name?: string } | null;
  } | null;
  readonly headRef?: { readonly target?: { readonly oid?: string } | null } | null;
  readonly baseRef?: { readonly compare?: { readonly behindBy?: number } | null } | null;
}

/** The pull request as GitHub has it now: merging and updating act on the head as it stands. */
async function actionState(ghPath: string, cwd: string, url: string): Promise<ActionState> {
  const parsed = parsePullRequestUrl(url);
  const [owner, name] = parsed?.repository.split("/") ?? [];
  if (parsed === undefined || owner === undefined || name === undefined) {
    throw new GitHubUnavailable("failed", `${url} is no pull request URL`);
  }
  const answer = (await ghJson(ghPath, cwd, [
    "api",
    "graphql",
    "--hostname",
    parsed.host,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${parsed.number}`,
    "-f",
    `headRef=refs/pull/${parsed.number}/head`,
    "-f",
    `query=${ACTION_STATE}`,
  ])) as { data?: { repository?: { pullRequest?: ActionState | null } | null } } | null;
  const state = answer?.data?.repository?.pullRequest;
  if (state === undefined || state === null || typeof state.id !== "string") {
    throw new GitHubUnavailable("failed", `GitHub did not find ${url}`);
  }
  return state;
}

/** Sends one of T3's mutations (`-f` strings, so a node id is never read as a number). */
async function mutate(
  ghPath: string,
  cwd: string,
  url: string,
  query: string,
  variables: Readonly<Record<string, string>>,
): Promise<void> {
  const host = parsePullRequestUrl(url)?.host ?? "github.com";
  await ghJson(ghPath, cwd, [
    "api",
    "graphql",
    "--hostname",
    host,
    ...Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
    "-f",
    `query=${query}`,
  ]);
}

/**
 * T3's delete-branch: the head branch of a pull request that is no longer open, unless it is
 * named like the base or the head repository's default branch, or moved since it was read.
 */
async function deleteHeadBranch(ghPath: string, cwd: string, url: string): Promise<void> {
  const state = await actionState(ghPath, cwd, url);
  if (state.state === "OPEN") {
    throw new GitHubUnavailable(
      "failed",
      "Close or merge this pull request before deleting its branch.",
    );
  }
  const branch = state.headRefName;
  const repository = state.headRepository;
  if (
    branch === undefined ||
    state.headRefOid === undefined ||
    typeof repository?.id !== "string"
  ) {
    throw new GitHubUnavailable(
      "failed",
      "The pull request's source branch is no longer available.",
    );
  }
  if (branch === state.baseRefName || branch === repository.defaultBranchRef?.name) {
    throw new GitHubUnavailable(
      "failed",
      `${branch} is a protected branch of this repository and is not deleted.`,
    );
  }
  // Already gone, which is what was asked for.
  if (state.headRef === null || state.headRef === undefined) return;
  if (state.headRef.target?.oid !== state.headRefOid) {
    throw new GitHubUnavailable(
      "failed",
      `${branch} has new commits since this pull request was read; it is not deleted.`,
    );
  }
  await mutate(ghPath, cwd, url, DELETE_BRANCH, {
    repository: repository.id,
    ref: `refs/heads/${branch}`,
    before: state.headRefOid,
  });
}

/**
 * T3's approve-workflows: the runs of a fork's head that wait for a maintainer's approval.
 * A branch of the repository itself needs none.
 */
async function approveWorkflows(ghPath: string, cwd: string, url: string): Promise<void> {
  const parsed = parsePullRequestUrl(url);
  const state = await actionState(ghPath, cwd, url);
  if (parsed === undefined || state.isCrossRepository !== true) return;
  const head = state.headRefOid;
  const owner = state.headRepositoryOwner?.login?.toLowerCase();
  if (head === undefined || owner === undefined) {
    throw new GitHubUnavailable("failed", "The pull request's head could not be read.");
  }
  const where = ["api", "--hostname", parsed.host];
  const runs = (await ghJson(ghPath, cwd, [
    ...where,
    `repos/${parsed.repository}/actions/runs?event=pull_request&status=action_required&head_sha=${head}&per_page=100`,
  ])) as {
    workflow_runs?: {
      id?: unknown;
      head_sha?: unknown;
      head_branch?: unknown;
      head_repository?: { owner?: { login?: unknown } } | null;
    }[];
  } | null;
  for (const run of runs?.workflow_runs ?? []) {
    const runOwner = run.head_repository?.owner?.login;
    if (
      typeof run.id !== "number" ||
      run.head_sha !== head ||
      run.head_branch !== state.headRefName ||
      typeof runOwner !== "string" ||
      runOwner.toLowerCase() !== owner
    ) {
      continue;
    }
    await ghRun(ghPath, cwd, [
      ...where,
      `repos/${parsed.repository}/actions/runs/${run.id}/approve`,
      "-X",
      "POST",
    ]);
  }
}

/** Runs a `git.pr.action` on GitHub as T3 does (D1451, D1661, D1662). */
async function actOn(
  ghPath: string,
  cwd: string,
  url: string,
  action: PullRequestAction,
  method: PullRequestMergeMethod,
  update: PullRequestUpdateMethod | undefined,
): Promise<void> {
  switch (action) {
    case "ready":
    case "close":
    case "reopen":
      return ghRun(ghPath, cwd, ["pr", action, url]);
    case "delete-branch":
      return deleteHeadBranch(ghPath, cwd, url);
    case "approve-workflows":
      return approveWorkflows(ghPath, cwd, url);
    case "merge": {
      // A base with a merge queue takes it through auto-merge (D1662); a state that cannot be
      // read leaves the merge to `gh`.
      const state = await actionState(ghPath, cwd, url).catch(() => undefined);
      if (state?.isMergeQueueEnabled !== true) {
        return ghRun(ghPath, cwd, ["pr", "merge", url, `--${method}`]);
      }
      return mutate(ghPath, cwd, url, ENABLE_AUTO_MERGE, {
        id: state.id,
        method: GRAPHQL_MERGE_METHODS[method],
      });
    }
    case "enable-auto-merge": {
      const state = await actionState(ghPath, cwd, url);
      // `--auto` on a pull request GitHub would merge now merges it, as `gh` does.
      if (
        state.isMergeQueueEnabled !== true &&
        IMMEDIATELY_MERGEABLE.has(state.mergeStateStatus?.toUpperCase() ?? "")
      ) {
        return ghRun(ghPath, cwd, ["pr", "merge", url, `--${method}`]);
      }
      return mutate(ghPath, cwd, url, ENABLE_AUTO_MERGE, {
        id: state.id,
        method: GRAPHQL_MERGE_METHODS[method],
      });
    }
    case "update-branch": {
      const state = await actionState(ghPath, cwd, url);
      if (state.baseRef?.compare?.behindBy === 0) return;
      if (state.headRefOid === undefined) {
        throw new GitHubUnavailable("failed", "The pull request's head could not be read.");
      }
      // GitHub updates with a merge commit unless asked to rebase.
      return mutate(ghPath, cwd, url, UPDATE_BRANCH, {
        id: state.id,
        head: state.headRefOid,
        method: update === "rebase" ? "REBASE" : "MERGE",
      });
    }
    default: {
      const name = SIMPLE_MUTATIONS[action];
      if (name === undefined) {
        throw new GitHubUnavailable("failed", `GitHub does not expose ${action} through its API.`);
      }
      const state = await actionState(ghPath, cwd, url);
      return mutate(
        ghPath,
        cwd,
        url,
        `mutation($id: ID!) { ${name}(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: state.id },
      );
    }
  }
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
    // T3's GitHub `changeRequestActions` (D1661).
    actions: [
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
      "delete-branch",
      "update-branch",
      "enable-auto-merge",
      "disable-auto-merge",
      "revert",
      "approve-workflows",
    ],
    updateMethods: ["merge", "rebase"],
    checks: (url) => checksOf(ghPath(), cwd, url),
    mergeMethods: (url) => mergeMethodsOf(ghPath(), cwd, url),
    act: (url, action, method, update) => actOn(ghPath(), cwd, url, action, method, update),
  };
}
