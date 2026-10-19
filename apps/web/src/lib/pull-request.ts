// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/pullRequest/pullRequestIcons.tsx (glyphs and state tones),
// pullRequest/pullRequestPresentation.tsx (resolvePullRequestState, the checks states) and
// ThreadStatusIndicators.tsx (prStatusIndicator: labels and tooltips).
import type { PullRequest, PullRequestChecks } from "@jhin/source-control-api";
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
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

function resolvePullRequestState(input: {
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
