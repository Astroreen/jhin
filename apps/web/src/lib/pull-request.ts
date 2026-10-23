// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/pullRequest/pullRequestIcons.tsx (glyphs and state tones),
// pullRequest/pullRequestPresentation.tsx (resolvePullRequestState, the checks states) and
// ThreadStatusIndicators.tsx (prStatusIndicator: labels and tooltips; the badge of several
// linked pull requests) and packages/shared/src/threadPullRequests.ts
// (resolveThreadPullRequestBadge, resolveThreadCurrentPullRequest).
import {
  pullRequestChains,
  type PullRequest,
  type PullRequestChecks,
  type ThreadPullRequest,
} from "@jhin/source-control-api";
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
} from "lucide-react";

interface PullRequestStatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: typeof GitPullRequestArrowIcon;
}

const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: GitPullRequestArrowIcon,
  },
  draft: {
    label: "Draft",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: GitPullRequestDraftIcon,
  },
  closed: {
    label: "Closed",
    toneClassName: "text-red-600 dark:text-red-300/90",
    Icon: GitPullRequestClosedIcon,
  },
  merged: {
    label: "Merged",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: GitMergeIcon,
  },
} as const satisfies Record<PullRequest["state"] | "draft", PullRequestStatePresentation>;

export function resolvePullRequestState(input: {
  readonly state: PullRequest["state"];
  readonly isDraft: boolean;
}): PullRequestStatePresentation {
  const key = input.state === "open" && input.isDraft ? "draft" : input.state;
  return PULL_REQUEST_STATE_PRESENTATION[key];
}

const CHECKS_STATE_PRESENTATION = {
  passing: {
    label: "All checks have passed",
    Icon: CircleCheckIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  failing: {
    label: "Some checks were not successful",
    Icon: CircleXIcon,
    toneClassName: "text-destructive",
  },
  pending: {
    label: "Some checks haven't completed yet",
    Icon: CircleDotIcon,
    toneClassName: "text-amber-600 dark:text-amber-400/90",
  },
} as const;

export function pullRequestChecksPresentation(checks: PullRequestChecks) {
  return checks.state === null ? null : CHECKS_STATE_PRESENTATION[checks.state];
}

export interface PrStatusIndicator {
  /** "PR open", "PR merged", … */
  readonly label: string;
  readonly colorClass: string;
  readonly Icon: PullRequestStatePresentation["Icon"];
  /** "PR #12 - Open: Add the thing" */
  readonly tooltip: string;
  readonly tooltipLead: string;
  readonly tooltipTitle: string;
  readonly url: string;
}

export function prStatusIndicator(pr: PullRequest | null | undefined): PrStatusIndicator | null {
  if (!pr) return null;
  const state = resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft });
  const tooltipLead = `PR #${pr.number} - ${state.label}`;
  return {
    label: `PR ${state.label.toLowerCase()}`,
    colorClass: state.toneClassName,
    Icon: state.Icon,
    tooltip: `${tooltipLead}: ${pr.title}`,
    tooltipLead,
    tooltipTitle: pr.title,
    url: pr.url,
  };
}

const DIFF_COUNT_FORMAT = new Intl.NumberFormat();

/** T3's formatDiffCount (client-runtime/diffCount.ts). */
export function formatDiffCount(count: number): string {
  return DIFF_COUNT_FORMAT.format(count);
}

/** T3's DiffStatLabel count: 1.2k, 34k, 5m. */
export function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  const compact = (scaled: number, unit: string) =>
    `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, "") : Math.round(scaled)}${unit}`;
  if (value < 1_000_000) return compact(value / 1000, "k");
  if (value < 1_000_000_000) return compact(value / 1_000_000, "m");
  return compact(value / 1_000_000_000, "b");
}

type PullRequestBadgeState = "open" | "draft" | "closed" | "merged";

/** What the card shows for a thread's linked pull requests (T3's resolveThreadPullRequestBadge). */
export type ThreadPullRequestBadge =
  | { readonly kind: "stack"; readonly layers: number; readonly state: PullRequestBadgeState }
  | {
      readonly kind: "pull-request";
      readonly others: number;
      readonly state: PullRequestBadgeState;
    };

export function threadPullRequestBadge(
  links: readonly ThreadPullRequest[],
): ThreadPullRequestBadge | null {
  if (links.length === 0) return null;
  const states = links.map((link) => link.snapshot?.state ?? "open");
  const state: PullRequestBadgeState = links.every(
    (link) => link.snapshot?.state === "open" && link.snapshot.isDraft,
  )
    ? "draft"
    : states.includes("open")
      ? "open"
      : states.every((entry) => entry === "merged")
        ? "merged"
        : "closed";
  if (links.length > 1 && pullRequestChains(links).length === 1) {
    return { kind: "stack", layers: links.length, state };
  }
  return { kind: "pull-request", others: links.length - 1, state };
}

/**
 * The pull request a thread is about now: the one open, the top open layer of
 * the newest chain when several are, else the top of the newest chain.
 */
export function currentPullRequest(
  links: readonly ThreadPullRequest[],
): ThreadPullRequest | undefined {
  const byKey = new Map(links.map((link) => [link.key, link]));
  const open = links.filter((link) => (link.snapshot?.state ?? "open") === "open");
  if (open.length === 1) return open[0];
  const chains = pullRequestChains(links).map((chain) => chain.keys.map((key) => byKey.get(key)!));
  for (const chain of chains) {
    const top = chain.toReversed().find((link) => (link.snapshot?.state ?? "open") === "open");
    if (top !== undefined) return top;
  }
  return chains[0]?.at(-1);
}

export interface ThreadPullRequestBadgePresentation {
  readonly Icon: PullRequestStatePresentation["Icon"];
  readonly toneClassName: string;
  readonly label: string;
  readonly text: string | number;
}

/** How the badge reads, as T3's resolveThreadPullRequestBadgePresentation words it. */
export function threadPullRequestBadgePresentation(
  badge: ThreadPullRequestBadge,
  current: ThreadPullRequest | undefined,
): ThreadPullRequestBadgePresentation | null {
  const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
  if (badge.kind === "stack") {
    return {
      Icon: LayersIcon,
      toneClassName: aggregate.toneClassName,
      label: `Stack of ${badge.layers} pull requests, ${aggregate.label.toLowerCase()}`,
      text: badge.layers,
    };
  }
  if (current === undefined) return null;
  const status = prStatusIndicator(current.snapshot);
  const tooltip = status?.tooltip ?? `PR #${current.number}, status pending`;
  if (badge.others > 0) {
    return {
      Icon: aggregate.Icon,
      toneClassName: aggregate.toneClassName,
      label: `${tooltip}, and ${badge.others} more linked; overall ${aggregate.label.toLowerCase()}`,
      text: `+${badge.others + 1}`,
    };
  }
  return {
    Icon: status?.Icon ?? GitPullRequestArrowIcon,
    toneClassName: status?.colorClass ?? "text-muted-foreground",
    label: tooltip,
    text: current.number,
  };
}

/** A row of a list of linked pull requests (T3's PullRequestListLine). */
export interface PullRequestListLine {
  readonly link: ThreadPullRequest;
  /** Its layer in its chain, 0 at the bottom. */
  readonly depth: number;
  /** The chain's layer count on its first row, when it chains more than one. */
  readonly stack: number | null;
}

/** Linked pull requests by chain, newest chain first, each bottom to top (T3's pullRequestListLines). */
export function pullRequestListLines(
  links: readonly ThreadPullRequest[],
): readonly PullRequestListLine[] {
  const byKey = new Map(links.map((link) => [link.key, link]));
  return pullRequestChains(links).flatMap((chain) =>
    chain.keys.map((key, depth) => ({
      link: byKey.get(key)!,
      depth,
      stack: depth === 0 && chain.keys.length > 1 ? chain.keys.length : null,
    })),
  );
}

/** A pull request's URL when it is a web page: a forge's answer is no reason to open anything else. */
export function webPageUrl(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** T3's words for a watched pull request's eye. */
export const WATCHING_DESCRIPTION =
  "Watching: the agent wakes when checks finish, someone comments, or the branch conflicts";
