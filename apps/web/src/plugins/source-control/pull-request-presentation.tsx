// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/pullRequest/pullRequestPresentation.tsx (PullRequestDiffStat,
// PullRequestReviewDecisionGlyph, PullRequestActorAvatar, the conflict glyph and a check's
// status icon), PullRequestListRow.tsx (PullRequestRowAuthor) and PullRequestChecksPopover.tsx
// (the checks popover and its lazily read body). docs/plans/source-control.md D1452, D1457.
import type { PullRequest, PullRequestCheck } from "@jhin/source-control-api";
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
  ScrollArea,
  Spinner,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  TriangleAlertIcon,
  UserCheckIcon,
  UserRoundIcon,
  UserRoundXIcon,
} from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { formatDiffCount } from "../../lib/pull-request.ts";
import {
  groupPullRequestChecks,
  pullRequestCheckStatusLabel,
  summarizePullRequestChecks,
  type ChecksState,
} from "../../lib/pull-request-detail.ts";

const SUCCESS_TONE = "text-emerald-600 dark:text-emerald-300/90";

/** T3's PullRequestDiffStat: `+12 -3`, nothing when both are 0. */
export function PullRequestDiffStat(props: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (props.additions === 0 && props.deletions === 0) return null;
  return (
    <span className={cn("inline-flex items-baseline gap-1 tabular-nums", props.className)}>
      <span className="text-diff-addition">+{formatDiffCount(props.additions)}</span>
      <span className="text-diff-deletion">-{formatDiffCount(props.deletions)}</span>
    </span>
  );
}

const REVIEW_DECISIONS = {
  approved: { Icon: UserCheckIcon, label: "Approved", toneClassName: SUCCESS_TONE },
  "changes-requested": {
    Icon: UserRoundXIcon,
    label: "Changes requested",
    toneClassName: "text-amber-600/90 dark:text-amber-400/80",
  },
  "review-required": {
    Icon: UserRoundIcon,
    label: "Awaiting review",
    toneClassName: "text-muted-foreground/60",
  },
} as const;

/** T3's PullRequestReviewDecisionGlyph. */
export function PullRequestReviewDecisionGlyph(props: {
  decision: NonNullable<PullRequest["reviewDecision"]>;
}) {
  const presentation = REVIEW_DECISIONS[props.decision];
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon aria-hidden className={cn("size-3.5", presentation.toneClassName)} />
        <span className="sr-only">{presentation.label}</span>
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

/** T3's PullRequestActorAvatar: the avatar, or the login's initial without one. */
function ActorAvatar(props: { actor: NonNullable<PullRequest["author"]>; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = props.actor.avatarUrl ?? null;
  if (url === null || failed === url) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground",
          props.className,
        )}
      >
        {props.actor.login.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      alt=""
      aria-hidden
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", props.className)}
      loading="lazy"
      onError={() => setFailed(url)}
      src={url}
    />
  );
}

/** T3's PullRequestRowAuthor: avatar and login, the name in the tooltip. */
export function PullRequestRowAuthor(props: {
  actor: NonNullable<PullRequest["author"]>;
  className?: string;
  labelClassName?: string;
}) {
  const { login, name } = props.actor;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("inline-flex min-w-0 items-center gap-1", props.className)} />}
      >
        <ActorAvatar actor={props.actor} className="size-3.5" />
        <span className={cn("truncate", props.labelClassName)}>{login}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {name && name !== login ? `${name} (@${login})` : login}
      </TooltipPopup>
    </Tooltip>
  );
}

/** T3's resolvePullRequestConflict: an open, ready pull request that conflicts with its base. */
export function pullRequestConflictLabel(pr: PullRequest | null): string | null {
  if (pr === null || pr.state !== "open" || pr.isDraft || pr.mergeability !== "conflicting") {
    return null;
  }
  return pr.baseBranch ? `Conflicts with ${pr.baseBranch}` : "Has conflicts";
}

/** T3's PullRequestConflictGlyph, the badge on a row's state glyph. */
export function PullRequestConflictGlyph(props: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="absolute -right-1 -bottom-1 inline-flex" />}>
        <TriangleAlertIcon
          aria-label={props.label}
          className="size-3 shrink-0 fill-background text-destructive [stroke-width:2.5]"
          role="img"
        />
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const CHECK_STATUS_ICONS = {
  pending: { Icon: null, toneClassName: "text-amber-500" },
  "action-required": {
    Icon: CircleDotIcon,
    toneClassName: "text-amber-600 dark:text-amber-400/90",
  },
  success: { Icon: CircleCheckIcon, toneClassName: SUCCESS_TONE },
  failure: { Icon: CircleXIcon, toneClassName: "text-destructive" },
  cancelled: { Icon: CircleXIcon, toneClassName: "text-destructive" },
  skipped: { Icon: CircleDashedIcon, toneClassName: "text-muted-foreground/70" },
  neutral: { Icon: CircleDashedIcon, toneClassName: "text-muted-foreground/70" },
} as const;

/** T3's PullRequestCheckStatusIcon: a spinner while running. */
export function PullRequestCheckStatusIcon(props: { status: PullRequestCheck["status"] }) {
  const presentation = CHECK_STATUS_ICONS[props.status];
  if (presentation.Icon === null) {
    return <Spinner className={cn("size-3.5 shrink-0", presentation.toneClassName)} />;
  }
  return (
    <presentation.Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
    />
  );
}

const CHECKS_STATES = {
  passing: { label: "All checks have passed", Icon: CircleCheckIcon, toneClassName: SUCCESS_TONE },
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

function ChecksBody(props: {
  checks: readonly PullRequestCheck[];
  openUrl: (url: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { attention, running, completed } = groupPullRequestChecks(props.checks);
  const canCollapse = attention.length + running.length > 0 && completed.length > 0;
  const visible = [...attention, ...running, ...(showAll || !canCollapse ? completed : [])];
  if (props.checks.length === 0) {
    return <p className="text-muted-foreground text-xs">No checks reported</p>;
  }
  return (
    <>
      <ScrollArea className="max-h-64">
        <ul aria-label="Checks" className="flex flex-col gap-1">
          {visible.map((check, index) => (
            <li className="flex items-center gap-2 text-xs" key={`${index}:${check.name}`}>
              <PullRequestCheckStatusIcon status={check.status} />
              <Tooltip>
                <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                  {check.name}
                </TooltipTrigger>
                <TooltipPopup side="top">{check.description ?? check.name}</TooltipPopup>
              </Tooltip>
              <span className="shrink-0 text-muted-foreground">
                {pullRequestCheckStatusLabel(check)}
              </span>
              {check.url === null ? null : (
                <button
                  className="shrink-0 text-primary hover:underline"
                  onClick={() => props.openUrl(check.url!)}
                  type="button"
                >
                  Details
                </button>
              )}
            </li>
          ))}
        </ul>
      </ScrollArea>
      {canCollapse ? (
        <Button
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
          size="xs"
          variant="ghost"
        >
          {showAll ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </>
  );
}

/** Reads the checks when the popover opens (T3's LazyChecksBody: one read per opened popover). */
function LazyChecksBody(props: {
  load: () => Promise<readonly PullRequestCheck[]>;
  openUrl: (url: string) => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; checks: readonly PullRequestCheck[] }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const { load } = props;
  useEffect(() => {
    let live = true;
    load().then(
      (checks) => {
        if (live) setState({ kind: "loaded", checks });
      },
      (error: unknown) => {
        if (live) setState({ kind: "failed", message: (error as Error).message });
      },
    );
    return () => {
      live = false;
    };
  }, [load]);
  if (state.kind === "failed") {
    return <p className="text-muted-foreground text-xs">{state.message}</p>;
  }
  if (state.kind === "loading") {
    return <p className="text-muted-foreground text-xs">Loading checks…</p>;
  }
  return <ChecksBody checks={state.checks} openUrl={props.openUrl} />;
}

/**
 * T3's PullRequestChecksPopover: the state's label, the summary and the checks. `count` (the
 * details row) shows "2/5" while running or "1 failed"; `icon` (a panel row) reads the checks
 * with `load` only once opened.
 */
export function PullRequestChecksPopover(props: {
  checksState: ChecksState;
  openUrl: (url: string) => void;
  checks?: readonly PullRequestCheck[];
  load?: () => Promise<readonly PullRequestCheck[]>;
  variant?: "icon" | "count";
  render?: ReactElement;
}) {
  const variant = props.variant ?? "icon";
  const presentation = CHECKS_STATES[props.checksState];
  const checks = props.checks;
  const running = checks?.filter((check) => check.status === "pending").length ?? 0;
  const failed =
    checks?.filter((check) => check.status === "failure" || check.status === "cancelled").length ??
    0;
  const summary = checks === undefined ? null : summarizePullRequestChecks(checks);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          variant === "count"
            ? `Open checks: ${summary ?? presentation.label}`
            : `Checks: ${presentation.label}`
        }
        nativeButton={variant === "count"}
        // A row is a link: the trigger is a span there, and its click opens only the checks.
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        render={
          variant === "count" ? (
            (props.render ?? <Button size="sm" variant="ghost" />)
          ) : (
            <span
              className="inline-flex shrink-0 cursor-pointer items-center"
              role="button"
              tabIndex={0}
            />
          )
        }
      >
        <presentation.Icon aria-hidden className={cn("size-3.5", presentation.toneClassName)} />
        {variant === "count" && checks !== undefined ? (
          running > 0 ? (
            <span className="tabular-nums">
              {running}/{checks.length}
            </span>
          ) : failed > 0 ? (
            <span className="tabular-nums">{failed} failed</span>
          ) : null
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" width="md">
        <PopoverTitle className="mb-2 font-medium text-sm">{presentation.label}</PopoverTitle>
        {summary === null ? null : <p className="mb-2 text-muted-foreground text-xs">{summary}</p>}
        {checks !== undefined ? (
          <ChecksBody checks={checks} openUrl={props.openUrl} />
        ) : props.load !== undefined ? (
          <LazyChecksBody load={props.load} openUrl={props.openUrl} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
