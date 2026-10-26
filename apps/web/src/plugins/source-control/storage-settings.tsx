// The Storage settings page's cleanup follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/settings/StorageSettings.tsx (CleanupSection, CleanupResults,
// lastRunSummary) and FoldedSettingsSection.tsx.
import type { Connections, NodeConnection } from "@jhin/client-api";
import {
  Button,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  SettingsRow,
  SettingsSection,
  cn,
  type Toasts,
} from "@jhin/ui";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "../../lib/format.ts";
import { useExternal } from "../../lib/hooks.ts";

interface CleanupEntry {
  readonly path: string;
  readonly threadId?: string;
  readonly outcome: "removed" | "kept" | "failed";
  readonly reason: string;
}

interface CleanupReport {
  readonly entries: readonly CleanupEntry[];
  readonly counts: { readonly removed: number; readonly kept: number; readonly failed: number };
  readonly finishedAt?: string;
}

interface NodeState {
  readonly report: CleanupReport | null;
  readonly rulesOn: boolean;
  readonly failed?: boolean;
}

const countsOf = (report: CleanupReport) =>
  `${report.counts.removed} removed, ${report.counts.kept} kept${report.counts.failed > 0 ? `, ${report.counts.failed} failed` : ""}`;

/** One line for the fold; identical results across nodes collapse into one (T3's `lastRunSummary`). */
export function lastRunSummary(
  entries: readonly { readonly label: string; readonly counts: string }[],
  nodeCount: number,
): string {
  const first = entries[0];
  if (first === undefined) return "";
  if (nodeCount <= 1) return first.counts;
  if (entries.length === nodeCount && entries.every((entry) => entry.counts === first.counts)) {
    return `${first.counts} on every node`;
  }
  return entries.map((entry) => `${entry.label}: ${entry.counts}`).join(" · ");
}

/** A report's entries as rows (T3's `CleanupResults`). */
function CleanupResults(props: {
  readonly report: CleanupReport;
  readonly nodeLabel: string | undefined;
  readonly titleOf: (threadId: string) => string | undefined;
}) {
  const prefix = props.nodeLabel === undefined ? "" : `${props.nodeLabel}: `;
  return (
    <>
      {props.report.entries.map((entry, index) => {
        const name = entry.path.split(/[\\/]/).findLast(Boolean) ?? entry.path;
        const title = entry.threadId === undefined ? undefined : props.titleOf(entry.threadId);
        return (
          <SettingsRow
            description={
              <span
                className={cn(
                  "wrap-anywhere",
                  entry.outcome === "failed" && "text-destructive-foreground",
                )}
              >
                {title !== undefined && title !== name ? `${title}. ` : ""}
                {entry.reason}
              </span>
            }
            key={`${entry.path}:${entry.threadId ?? index}`}
            title={`${prefix}${entry.threadId === undefined ? entry.path : name}`}
          />
        );
      })}
      {props.report.entries.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {prefix}Nothing needed cleanup.
        </p>
      ) : null}
    </>
  );
}

/**
 * T3's "Cleanup" of the Storage page (D1469): "Delete now" on every
 * connected node, its last run per node, and the fold with each entry.
 */
export function CleanupSection(props: {
  readonly connections: Connections;
  readonly toasts: Toasts | undefined;
  readonly titleOf: (node: string, threadId: string) => string | undefined;
}) {
  const nodes = useExternal(props.connections, props.connections.list).filter(
    (node) => node.state === "open",
  );
  const [states, setStates] = useState<ReadonlyMap<string, NodeState>>(new Map());
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const ids = nodes.map((node) => node.id).join("\n");

  /** The latest read of each node: an older answer that lands later is dropped. */
  const reads = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const read = async (node: NodeConnection) => {
    const ticket = (reads.current.get(node.id) ?? 0) + 1;
    reads.current.set(node.id, ticket);
    const next = await node.client
      .call<NodeState>("git.worktree.cleanup.report", {})
      .catch((): NodeState => ({ report: null, rulesOn: false, failed: true }));
    if (!mounted.current || reads.current.get(node.id) !== ticket) return;
    // A read that failed keeps the report already shown: the cleanup still ran.
    setStates((current) => {
      const shown = current.get(node.id);
      const kept =
        next.failed === true && shown?.report != null ? { ...shown, failed: true } : next;
      return new Map(current).set(node.id, kept);
    });
  };
  useEffect(() => {
    mounted.current = true;
    for (const node of nodes) void read(node);
    return () => {
      mounted.current = false;
    };
  }, [ids]);

  const hasRules = nodes.some((node) => states.get(node.id)?.rulesOn === true);
  const summaries = nodes.map((node) => {
    const state = states.get(node.id);
    const report = state?.report ?? null;
    return {
      node,
      report,
      counts: report === null ? "" : countsOf(report),
      description:
        report?.finishedAt !== undefined
          ? `Last run ${formatRelativeTimeLabel(report.finishedAt)}.${report.counts.failed > 0 ? ` ${report.counts.failed} ${report.counts.failed === 1 ? "item" : "items"} couldn't be removed.` : ""}`
          : state?.failed === true
            ? "Could not load the last run."
            : state === undefined
              ? "Loading last run…"
              : "Cleanup hasn't run yet.",
    };
  });

  const deleteNow = async () => {
    if (pending) return;
    setPending(true);
    try {
      await Promise.all(
        nodes
          .filter((node) => states.get(node.id)?.rulesOn === true)
          .map(async (node) => {
            try {
              const report = await node.client.call<CleanupReport>("git.worktree.cleanup", {});
              const failure = report.entries.find((entry) => entry.outcome === "failed");
              if (failure !== undefined) {
                props.toasts?.show({
                  type: "error",
                  title: `Cleanup failed on ${node.label}`,
                  description: failure.reason,
                });
              }
            } catch (error) {
              props.toasts?.show({
                type: "error",
                title: `Could not run cleanup on ${node.label}`,
                description: (error as Error).message,
              });
            }
            await read(node);
          }),
      );
    } finally {
      setPending(false);
    }
  };

  const reported = summaries.filter((summary) => summary.report !== null);
  return (
    <SettingsSection title="Cleanup">
      <SettingsRow
        control={
          <Button
            disabled={pending || !hasRules}
            onClick={() => void deleteNow()}
            size="sm"
            variant="outline"
          >
            {pending ? "Deleting…" : "Delete now"}
          </Button>
        }
        description={
          !hasRules
            ? "Turn on a cleanup rule to use this."
            : summaries.map((summary) => (
                <span className="block" key={summary.node.id}>
                  {nodes.length > 1 ? `${summary.node.label}: ` : ""}
                  {summary.description}
                </span>
              ))
        }
        title="Delete now"
      />
      {reported.length === 0 ? null : (
        <Collapsible onOpenChange={setOpen} open={open}>
          <CollapsibleTrigger className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium">Last run</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {lastRunSummary(
                reported.map((summary) => ({ label: summary.node.label, counts: summary.counts })),
                nodes.length,
              )}
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
              {reported.map((summary) => (
                <CleanupResults
                  key={summary.node.id}
                  nodeLabel={nodes.length > 1 ? summary.node.label : undefined}
                  report={summary.report!}
                  titleOf={(threadId) => props.titleOf(summary.node.id, threadId)}
                />
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </SettingsSection>
  );
}
