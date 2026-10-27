// The worktree setup card is T3 Code's (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/WorktreeSetupCard.tsx, with when it shows from
// apps/web/src/components/chat/MessagesTimeline.logic.ts (under the first message,
// collapsed to one row once the agent has started and the setup is over).
// A chunk of its own (D1595): worktree-setup-header.tsx loads it for a thread that has a setup.
import {
  worktreeSetupStageLabel,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@jhin/source-control-api";
import { Button, Spinner, cn } from "@jhin/ui";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  LaptopIcon,
  MinusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { formatDuration } from "../../lib/format.ts";
import { MiddleTruncate } from "../../lib/middle-truncate.tsx";

function useNowWhile(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

function stageElapsedMs(stage: WorktreeSetupStage, nowMs: number): number | null {
  if (!stage.startedAt) return null;
  const start = Date.parse(stage.startedAt);
  const end = stage.endedAt ? Date.parse(stage.endedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function StageIcon({ status }: { status: WorktreeSetupStage["status"] }) {
  const className = "size-4 shrink-0 stroke-2";
  switch (status) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    case "running":
      return <Spinner className="size-4 shrink-0" />;
    case "failed":
      return <XIcon aria-hidden className={className} />;
    case "warning":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "skipped":
      return <MinusIcon aria-hidden className={className} />;
    case "pending":
      return <CircleIcon aria-hidden className={className} />;
  }
}

function stageRowClassName(status: WorktreeSetupStage["status"]): string {
  switch (status) {
    case "failed":
      return "text-destructive-foreground";
    case "warning":
      return "text-warning-foreground";
    case "pending":
      return "text-secondary-label opacity-40";
    case "running":
    case "skipped":
    case "done":
      return "text-secondary-label";
  }
}

function worktreeSetupHeader(snapshot: WorktreeSetupSnapshot): string {
  switch (snapshot.phase) {
    case "running":
      return "Setting up worktree…";
    case "done":
      return snapshot.stages.some((stage) => stage.status === "failed")
        ? "Worktree ready, setup script failed"
        : "Worktree ready";
    case "failed":
      return "Worktree setup failed";
    case "cancelled":
      return "Worktree setup cancelled";
  }
}

/** A line of the card, laid out as the timeline's work rows. */
function SetupRow(props: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  stage: string;
  status: string;
}) {
  return (
    <div
      className="flex min-h-6 min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm leading-relaxed"
      data-worktree-setup-stage={props.stage}
      data-worktree-setup-status={props.status}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        {props.icon}
      </span>
      <div className="min-w-0 flex-1 truncate">{props.label}</div>
      {props.trailing}
    </div>
  );
}

function StageRow({
  stage,
  nowMs,
  scriptName,
}: {
  stage: WorktreeSetupStage;
  nowMs: number;
  scriptName: string | null;
}) {
  const elapsed = stageElapsedMs(stage, nowMs);
  const label =
    stage.id === "setup-script" && scriptName ? scriptName : worktreeSetupStageLabel(stage.id);
  const running = stage.status === "running";
  const trailing =
    stage.status === "pending"
      ? null
      : stage.status === "skipped"
        ? (stage.detail ?? "skipped")
        : stage.id === "checkout" && running && stage.percent !== null
          ? `${stage.percent}%`
          : stage.detail;
  return (
    <SetupRow
      icon={
        <span className={cn(stage.status === "pending" && "opacity-40")}>
          <StageIcon status={stage.status} />
        </span>
      }
      label={<span className={cn("block truncate", stageRowClassName(stage.status))}>{label}</span>}
      stage={stage.id}
      status={stage.status}
      trailing={
        <>
          {trailing ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
              {trailing}
            </span>
          ) : null}
          {elapsed !== null && stage.status !== "skipped" && stage.status !== "pending" ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatDuration(elapsed)}
            </span>
          ) : null}
        </>
      }
    />
  );
}

const OUTPUT_TAIL_LINES = 4;
const OUTPUT_TAIL_SLOTS = Array.from({ length: OUTPUT_TAIL_LINES }, (_, slot) => slot);

function OutputTail({ lines, failed }: { lines: readonly string[]; failed: boolean }) {
  return (
    <pre
      aria-label="Setup script output"
      className={cn(
        "mb-1 ml-8 overflow-hidden rounded-md border px-2.5 py-1.5 font-mono text-2xs leading-relaxed select-text",
        failed
          ? "border-destructive/20 bg-destructive/5 text-destructive-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {OUTPUT_TAIL_SLOTS.map((slot) => {
        const line = lines[lines.length - OUTPUT_TAIL_LINES + slot] ?? "";
        return (
          <div key={slot} className="truncate whitespace-pre">
            {line.length === 0 ? " " : line}
          </div>
        );
      })}
    </pre>
  );
}

function SetupDetails({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  const row = (term: string, value: ReactNode) => (
    <>
      <dt className="text-foreground/80">{term}</dt>
      <dd className="min-w-0 font-mono">{value}</dd>
    </>
  );
  return (
    <dl className="mt-1 mb-1.5 ml-8 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {snapshot.branch ? row("Branch", <MiddleTruncate value={snapshot.branch} />) : null}
      {snapshot.baseRef ? row("Base", <MiddleTruncate value={snapshot.baseRef} />) : null}
      {snapshot.worktreePath ? row("Path", <MiddleTruncate value={snapshot.worktreePath} />) : null}
      {snapshot.setupScript
        ? row("Setup", <span className="block truncate">{snapshot.setupScript.command}</span>)
        : null}
    </dl>
  );
}

function CollapsedSummaryRow({
  snapshot,
  totalElapsed,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: number | null;
}) {
  const status: WorktreeSetupStage["status"] =
    snapshot.phase === "failed" || snapshot.phase === "cancelled"
      ? "failed"
      : snapshot.stages.some((stage) => stage.id === "setup-script" && stage.status === "failed")
        ? "failed"
        : "done";
  return (
    <SetupRow
      icon={<StageIcon status={status} />}
      label={<span className={stageRowClassName(status)}>{worktreeSetupHeader(snapshot)}</span>}
      stage="summary"
      status={status}
      trailing={
        totalElapsed !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDuration(totalElapsed)}
          </span>
        ) : null
      }
    />
  );
}

/** T3's `WorktreeSetupCard`: a new worktree's stages, its script's output and its actions. */
export function WorktreeSetupCard({
  snapshot,
  embedded,
  onCancel,
  onWorkLocally,
  onOpenTerminal,
}: {
  snapshot: WorktreeSetupSnapshot;
  /** The agent has started and the setup is over: one summary row. */
  embedded: boolean;
  onCancel: (() => void) | null;
  /** T3's "Work locally": cancel, and the first turn starts in the project's checkout (D1477). */
  onWorkLocally: (() => void) | null;
  onOpenTerminal: (() => void) | null;
}) {
  const running = snapshot.phase === "running";
  const nowMs = useNowWhile(running);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const totalElapsed = (() => {
    const start = Date.parse(snapshot.startedAt);
    const end = snapshot.endedAt ? Date.parse(snapshot.endedAt) : nowMs;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  })();
  const setupStage = snapshot.stages.find((stage) => stage.id === "setup-script");
  const showTerminal = onOpenTerminal && setupStage && setupStage.status !== "pending";
  const collapsed = embedded && !running;
  const showHeader = !embedded && snapshot.phase !== "done";
  const failed = snapshot.phase === "failed";
  const finishedWithFailedStage =
    snapshot.phase === "done" && snapshot.stages.some((stage) => stage.status === "failed");
  const showTail =
    setupStage !== undefined &&
    (setupStage.status === "failed" ||
      (setupStage.status === "running" && setupStage.tail.length > 0));

  return (
    <section
      aria-label="Worktree setup"
      className="my-1.5"
      data-worktree-setup-phase={snapshot.phase}
    >
      {showHeader ? (
        <div className="border-b border-border/60 pt-1 pb-2">
          <div
            className={cn(
              "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums",
              failed
                ? "text-destructive-foreground"
                : finishedWithFailedStage
                  ? "text-warning-foreground"
                  : "text-muted-foreground",
            )}
          >
            <span className="min-w-0 shrink truncate" role={running ? "status" : undefined}>
              {worktreeSetupHeader(snapshot)}
            </span>
            {totalElapsed !== null ? (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {formatDuration(totalElapsed)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {collapsed ? (
        <CollapsedSummaryRow snapshot={snapshot} totalElapsed={totalElapsed} />
      ) : (
        <div className={showHeader ? "pt-1.5" : undefined}>
          {snapshot.stages.map((stage) => (
            <div key={stage.id}>
              <StageRow
                nowMs={nowMs}
                scriptName={snapshot.setupScript?.name ?? null}
                stage={stage}
              />
              {stage.id === "setup-script" && showTail ? (
                <OutputTail failed={stage.status === "failed"} lines={stage.tail} />
              ) : null}
            </div>
          ))}
        </div>
      )}

      {failed && snapshot.error ? (
        <p className="mt-1 ml-8 text-xs text-muted-foreground">{snapshot.error}</p>
      ) : null}

      {detailsOpen ? <SetupDetails snapshot={snapshot} /> : null}

      <div className="mt-0.5 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex flex-wrap items-center gap-0.5">
        <Button
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
          size="xs"
          type="button"
          variant="ghost-muted"
        >
          {detailsOpen ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          Details
        </Button>
        {showTerminal ? (
          <Button onClick={onOpenTerminal} size="xs" type="button" variant="ghost-muted">
            <TerminalIcon aria-hidden />
            Open terminal
          </Button>
        ) : null}
        {onWorkLocally && running ? (
          <Button onClick={onWorkLocally} size="xs" type="button" variant="ghost-muted">
            <LaptopIcon aria-hidden />
            Work locally
          </Button>
        ) : null}
        {onCancel && running ? (
          <Button onClick={onCancel} size="xs" type="button" variant="ghost-muted">
            <XIcon aria-hidden />
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}
