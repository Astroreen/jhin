// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ProviderSubagentBar.tsx and formatProviderSubagentStatus of
// packages/client-runtime/src/state. Decisions: docs/plans/orchestration.md (D880).
import type { ThreadRecord } from "@jhin/client-api";
import { Button } from "@jhin/ui";
import { ArrowUpLeftIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { AgentIcon } from "../../lib/agent-icon.tsx";
import { formatDuration } from "../../lib/format.ts";

const LABELS: Record<string, string> = {
  running: "Working",
  waiting: "Waiting",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
};

/** The state alone, announced without a ticking time (T3's announcement). */
export const subagentLabel = (thread: ThreadRecord): string =>
  thread.lastTurn === undefined ? "Starting" : (LABELS[thread.lastTurn.status] ?? "Working");

/** T3's status line of a subagent: "Working 12s", "Completed in 1m 3s", or the state. */
export function subagentStatus(thread: ThreadRecord, nowMs: number): string {
  const turn = thread.lastTurn;
  if (turn === undefined) return "Starting";
  const label = LABELS[turn.status] ?? "Working";
  const live = turn.status === "running" || turn.status === "waiting";
  if (!live && turn.status !== "completed") return label;
  const start = Date.parse(thread.createdAt);
  const end = live ? nowMs : Date.parse(turn.at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return label;
  const elapsed = formatDuration(Math.max(1_000, Math.floor((end - start) / 1_000) * 1_000));
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

/** In place of the composer: a subagent its parent's agent runs takes no messages (D880). */
export function SubagentBar(props: {
  readonly thread: ThreadRecord;
  readonly onOpenParent: (() => void) | undefined;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  const { thread } = props;
  const live = thread.lastTurn?.status === "running" || thread.lastTurn?.status === "waiting";
  const model = thread.model ?? "Subagent";
  // The label is written from an effect, so a running timer never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) statusRef.current.textContent = subagentStatus(thread, Date.now());
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, thread]);
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        {thread.agentId === undefined ? null : (
          <AgentIcon agentId={thread.agentId} className="size-4 shrink-0" />
        )}
        <span className="min-w-0 truncate font-medium text-foreground">{model}</span>
      </span>
      <span
        ref={statusRef}
        aria-hidden
        className="min-w-0 truncate text-muted-foreground tabular-nums"
      />
      <span role="status" className="sr-only">
        {`${model} subagent: ${subagentLabel(thread)}`}
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground max-sm:hidden">Runs on its own</span>
      {props.onOpenParent ? (
        <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
          <ArrowUpLeftIcon />
          Open parent
        </Button>
      ) : null}
    </div>
  );
}
