// Watching a pull request follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/orchestration-v2/pullRequestWatch.ts (evaluatePullRequestWatch, the wake
// message and its limits) and PullRequestWatchReactor.ts (stopping on merge, close and failed
// reads, and their messages), with "Jhin" for "T3 Code".
import {
  PULL_REQUEST_WATCH_FAILURE_LIMIT,
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  type PullRequestWatch,
} from "@jhin/source-control-api";

type CheckStatus =
  | "success"
  | "failure"
  | "cancelled"
  | "pending"
  | "action-required"
  | "skipped"
  | "neutral";

interface WatchedCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly url?: string;
  /** Required by the base branch's protection, when the forge says (D908). */
  readonly required?: boolean;
}

/** A comment or a review on the pull request. */
export interface Remark {
  readonly id: string;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt?: string;
  readonly path?: string;
  /** A review's state ("APPROVED", "CHANGES_REQUESTED"), shown when it says nothing. */
  readonly reviewState?: string;
  readonly url?: string;
}

/** What a watch reads of a pull request each time. */
export interface WatchRead {
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string | null;
  readonly baseBranch: string;
  readonly checks: readonly WatchedCheck[];
  /**
   * False when the forge could not say this time which checks are required (D908): the
   * "passed" state is left as it was rather than judged against a different gate.
   */
  readonly requiredKnown?: boolean;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly author: string | null;
  /** Who the node's forge account is: its own remarks never wake the thread. */
  readonly viewer: string | null;
  readonly remarks: readonly Remark[];
}

type WatchChange =
  | { readonly kind: "checks-failed"; readonly failed: readonly WatchedCheck[] }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | { readonly kind: "remarks"; readonly remarks: readonly Remark[] }
  | { readonly kind: "conflicting" };

export interface WatchReport {
  readonly changes: readonly WatchChange[];
  readonly next: PullRequestWatch;
  /** Ten comment-only wakes in a row: the watch stops. */
  readonly exhausted: boolean;
}

const SNIPPET_LENGTH = 200;
const LISTED_ITEMS = 10;

const isFailed = (check: WatchedCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

export function startWatch(now: string): PullRequestWatch {
  return {
    startedAt: now,
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: now,
    remarkIds: [],
    conflicting: false,
    wakes: 0,
    failures: 0,
  };
}

/** What changed since the watch last told its thread. */
export function evaluateWatch(watch: PullRequestWatch, read: WatchRead): WatchReport {
  const changes: WatchChange[] = [];
  const headMoved = read.headSha !== watch.headSha;
  // An empty list keeps the last state: a forge can answer with one when its check read fails.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  let passedChecks = headMoved ? [] : watch.passedChecks;
  if (read.checks.length > 0) {
    const failed = read.checks.filter(isFailed);
    const fresh = failed.filter((check) => !failedChecks.includes(check.name));
    if (fresh.length > 0) changes.push({ kind: "checks-failed", failed: fresh });
    failedChecks = failed.map((check) => check.name);
  }
  if (read.checks.length > 0 && read.requiredKnown !== false) {
    // T3's gate (D908): the required checks when the base branch names some, else every check.
    const required = read.checks.filter((check) => check.required === true);
    const gate = required.length > 0 ? required : read.checks;
    const passedNow = gate.every((check) => check.status !== "pending" && !isFailed(check));
    const gateNames = gate.map((check) => check.name);
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // A required job created and finished between two reads is never seen pending. Without
    // required checks any check counts, and bots keep adding passed ones: no wake for those.
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    if (passedNow && (!passed || gateGrew)) {
      changes.push({ kind: "checks-passed", count: gate.length, required: required.length > 0 });
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  const own = new Set(
    [read.viewer, read.author].filter((name) => name !== null).map((name) => name!.toLowerCase()),
  );
  const parsedThrough = Date.parse(watch.remarksThrough);
  const through = Number.isNaN(parsedThrough) ? Date.parse(watch.startedAt) : parsedThrough;
  const activeAt = (remark: Remark) => remark.editedAt ?? remark.createdAt;
  // Times are per second: remarks at the boundary are told apart by id.
  const fresh = read.remarks.filter((remark) => {
    const at = Date.parse(activeAt(remark));
    // A time the forge wrote that cannot be read is no news.
    if (Number.isNaN(at)) return false;
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      !own.has(remark.author?.toLowerCase() ?? "")
    );
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(activeAt(remark))));
  const atLatest = fresh.filter((remark) => Date.parse(activeAt(remark)) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : activeAt(atLatest[0]!);
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  if (read.mergeability === "conflicting" && !watch.conflicting)
    changes.push({ kind: "conflicting" });
  // "unknown" is the forge still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    read.mergeability === "unknown" ? watch.conflicting : read.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      headSha: read.headSha,
      failedChecks,
      passed,
      passedChecks,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
      failures: 0,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: readonly T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function changeLines(change: WatchChange, baseBranch: string, commit: string): string[] {
  switch (change.kind) {
    case "checks-failed":
      return [
        `- Checks failed${commit}:`,
        ...listed(
          change.failed,
          (check) =>
            `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`,
        ),
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.required ? "required " : ""}${change.count === 1 ? "check" : "checks"} passed${commit}.`,
      ];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) => {
          const where = remark.path === undefined ? "" : ` on ${remark.path}`;
          const body = snippet(remark.body);
          const said = body.length === 0 ? (remark.reviewState ?? "reviewed") : `"${body}"`;
          return `  - ${remark.author ?? "someone"}${where}: ${said}${remark.url ? ` ${remark.url}` : ""}`;
        }),
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${baseBranch}.`];
  }
}

/** The message that wakes the thread: what changed, and how to go on. */
export function watchMessage(input: {
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly report: WatchReport;
}): string {
  const commit = input.headSha === null ? "" : ` on ${input.headSha.slice(0, 7)}`;
  return [
    `Update on pull request #${input.number} (${input.url}), which Jhin is watching for you:`,
    ...input.report.changes.flatMap((change) => changeLines(change, input.baseBranch, commit)),
    "",
    input.report.exhausted
      ? `Jhin stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call git_pr_watch to watch it again.`
      : "Look into each item and act on it as your task requires. Jhin keeps watching and wakes you on the next change, so end your turn when you are done. When you hand the work back to the user, call git_pr_unwatch first.",
  ].join("\n");
}

export const closedMessage = (number: number, url: string) =>
  `Pull request #${number} (${url}) was closed, so Jhin stopped watching it. Call git_pr_watch if it reopens.`;

export const unreadableMessage = (number: number, url: string) =>
  `Jhin stopped watching pull request #${number} (${url}) because it failed to read it from the host ${PULL_REQUEST_WATCH_FAILURE_LIMIT} times in a row. Check it yourself, and call git_pr_watch to watch it again.`;
