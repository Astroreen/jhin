// The Usage page's limits (t3-parity.md D1308–D1310), a chunk of its own (D1595). Derived from
// T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/components/usage/UsagePage.tsx
// (its "Limits" view: the breadcrumb, "Refresh limits"), UsageLimitsPooled.tsx (PoolSection,
// PoolWindowCard, PoolBar, PoolSegment, LimitNotices) and UsageLimits.tsx (ResetCredits,
// ResetCreditDialog, useResetCredit).
import type { AgentResetCreditOutcome, AgentResetCredits } from "@jhin/agent-api";
import { targetKey, type ThreadsCatalog } from "@jhin/client-api";
import type { Logger } from "@jhin/sdk";
import {
  Alert,
  AlertTitle,
  Button,
  type Dialogs,
  Spinner,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@jhin/ui";
import { AlertTriangleIcon, ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgentIcon } from "../lib/agent-icon.tsx";
import { useExternal } from "../lib/hooks.ts";
import type { createShownNodes } from "../lib/nodes.ts";
import { PaceIcon } from "../lib/pace-icon.tsx";
import {
  collectLimitPools,
  limitNotices,
  readUsage,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  type UsageRead,
} from "../lib/usage-pools.ts";
import { formatResetsIn, remainingPercent, resetCreditsSummary } from "../lib/usage-limits.ts";

export interface UsagePageProps {
  readonly threads: ThreadsCatalog;
  readonly shown: ReturnType<typeof createShownNodes>;
  readonly close: () => void;
  readonly log: Logger;
  /** Asks before a reset credit is spent; without it "Use reset" is disabled. */
  readonly dialogs: Dialogs | undefined;
}

/** One colour for every agent, as the composer's bars (D1144). */
const BAR_COLOR = "var(--contrast-foreground, var(--foreground))";

function PoolSegment(props: {
  readonly account: LimitAccount;
  readonly window: NonNullable<LimitPoolWindow["columns"][number]["window"]>;
  readonly now: number;
  readonly index: number;
  readonly showName: boolean;
}) {
  const { account, window, now } = props;
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt === undefined ? null : new Date(window.resetsAt);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`${account.nodeLabel}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}`}
            className="relative h-8 min-w-0 cursor-default overflow-hidden rounded-md bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            style={{ gridColumn: props.index, gridRow: 1 }}
            type="button"
          />
        }
      >
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-md opacity-35"
          style={{ width: `${remaining}%`, backgroundColor: BAR_COLOR }}
        />
        <div aria-hidden className="relative flex h-full min-w-0 items-center gap-1.5 px-2 text-xs">
          {props.showName ? (
            <span className="min-w-0 truncate font-medium text-foreground">
              {account.nodeLabel}
            </span>
          ) : null}
          <span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>
          {resetsIn ? (
            <span className="ms-auto shrink-0 rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs text-foreground tabular-nums">
              {resetsIn.replace("resets in ", "↻ ")}
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">Signed in</span>
          <span className="text-foreground">{account.nodeLabel}</span>
          <span className="text-muted-foreground">Left</span>
          <span className="text-foreground tabular-nums">{remaining}%</span>
          {resetsAt !== null ? (
            <>
              <span className="text-muted-foreground">Resets</span>
              <span className="text-foreground tabular-nums">
                {resetsAt.toLocaleString()}
                {resetsIn ? ` · ${resetsIn}` : ""}
              </span>
            </>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function PoolWindowCard(props: { readonly pool: LimitPoolWindow; readonly now: number }) {
  const { pool } = props;
  return (
    <div
      aria-label={`${pool.label}: ${pool.remainingPercent}% left`}
      className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]"
      role="group"
    >
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{pool.label}</span>
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {pool.remainingPercent}%
          </span>
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span>left</span>
            {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
          </span>
        </span>
      </div>
      <div
        className="grid min-w-0 gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((column, position) =>
          column.window ? (
            <PoolSegment
              account={column.account}
              index={position + 1}
              key={column.account.key}
              now={props.now}
              showName={pool.columns.length > 1}
              window={column.window}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

const OUTCOME_TEXT: Record<AgentResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/**
 * An account's reset credits under its agent's limits (t3-parity.md D1655, D1656): "Use reset"
 * asks first, since it spends a credit the account was granted, then says what it did and has
 * the page read the limits again. With every credit used it stays to say so beside the result.
 */
export function ResetCredits(props: {
  readonly account: LimitAccount;
  readonly credits: AgentResetCredits;
  readonly now: number;
  readonly showName: boolean;
  readonly threads: ThreadsCatalog;
  readonly dialogs: Dialogs | undefined;
  /** The redemption ended: the page reads the limits again. */
  readonly redeemed: () => void;
}) {
  const { account, credits, dialogs } = props;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const redeem = async () => {
    if (dialogs === undefined) return;
    const confirmed = await dialogs.confirm({
      title: "Use a reset credit?",
      description:
        "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
      confirmLabel: "Use credit",
    });
    if (!confirmed) return;
    setBusy(true);
    setStatus(null);
    try {
      const { outcome } = await props.threads.call<{ outcome: AgentResetCreditOutcome }>(
        account.target,
        "agents.reset-credit.consume",
        { agentId: account.agentId },
      );
      setStatus(OUTCOME_TEXT[outcome]);
    } catch {
      setStatus("Could not use the reset credit.");
    } finally {
      setBusy(false);
    }
    props.redeemed();
  };
  if (credits.availableCount === 0 && status === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {props.showName ? (
        <span className="font-medium text-foreground">{account.nodeLabel}</span>
      ) : null}
      <span className="tabular-nums">{resetCreditsSummary(credits, props.now)}</span>
      {credits.availableCount > 0 ? (
        <Button
          disabled={busy || dialogs === undefined}
          onClick={() => void redeem()}
          size="xs"
          variant="outline"
        >
          {busy ? "Using…" : "Use reset"}
        </Button>
      ) : null}
      {status ? (
        <span className="text-foreground" role="status">
          {status}
        </span>
      ) : null}
    </div>
  );
}

function PoolSection(props: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly threads: ThreadsCatalog;
  readonly dialogs: Dialogs | undefined;
  readonly redeemed: () => void;
}) {
  const { pool } = props;
  return (
    <section aria-label={pool.agentName} className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AgentIcon agentId={pool.agentId} className="size-4 text-foreground/80" />
        {pool.agentName}
      </h2>
      {pool.windows.map((window) => (
        <PoolWindowCard key={`${window.kind}:${window.id}`} now={props.now} pool={window} />
      ))}
      {pool.accounts.map((account) =>
        account.limits.resetCredits === undefined ? null : (
          <ResetCredits
            account={account}
            credits={account.limits.resetCredits}
            dialogs={props.dialogs}
            key={account.key}
            now={props.now}
            redeemed={props.redeemed}
            showName={pool.accounts.length > 1}
            threads={props.threads}
          />
        ),
      )}
    </section>
  );
}

export function UsagePage(props: UsagePageProps) {
  const { threads, shown, close, log, dialogs } = props;
  const nodes = useExternal(shown, shown.snapshot);
  const [read, setRead] = useState<UsageRead | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  // The open nodes and their names, not their catalogs' every change.
  const nodesKey = JSON.stringify(
    nodes
      .filter((node) => node.state === "open")
      .map((node) => [targetKey(node.target), node.label]),
  );
  const latest = useRef({ nodes, request: 0 });
  latest.current.nodes = nodes;
  // Each runtime reads its limits again once what it knows is a minute old (D1304).
  // Only the latest read is shown: one a later one superseded is dropped.
  const load = useCallback(() => {
    const request = ++latest.current.request;
    setRefreshing(true);
    readUsage(threads, latest.current.nodes)
      .then(
        (next) => {
          if (latest.current.request === request) setRead(next);
        },
        (error: unknown) => log.warn("could not read the usage limits", { error: String(error) }),
      )
      .finally(() => {
        if (latest.current.request === request) setRefreshing(false);
      });
  }, []);
  useEffect(() => {
    load();
  }, [nodesKey, load]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape that closes a field, dialog, menu, list or tooltip first is theirs.
      if (
        (event.target as HTMLElement | null)?.closest(
          "input, textarea, [role=dialog], [role=menu], [role=listbox], [role=tooltip]",
        )
      )
        return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const pools = read === undefined ? [] : collectLimitPools(read.accounts, read.now);
  const notices =
    read === undefined ? [] : [...read.failures, ...limitNotices(read.accounts, read.severalNodes)];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) wco:pr-(--workspace-native-controls-inset) group-data-[sidebar-state=collapsed]/sidebar-wrapper:ps-[calc(var(--workspace-titlebar-content-left))]">
        <nav aria-label="Usage breadcrumb" className="flex min-w-0 items-center text-sm">
          <h1 className="truncate font-medium text-foreground">Usage</h1>
        </nav>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <Button
            aria-label="Refresh limits"
            disabled={refreshing}
            onClick={load}
            size="xs"
            variant="ghost"
          >
            <RefreshCwIcon className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />
          </Button>
          <Button onClick={close} size="xs" variant="ghost">
            <ArrowLeftIcon className="mx-0.5 size-3.5" />
            Back
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 pt-6 pb-12 sm:px-6">
          {read === undefined ? (
            <Spinner size="sm" tone="muted" />
          ) : read.nodes === 0 ? (
            <p className="text-sm text-muted-foreground">
              {nodes.length === 0
                ? "Connect a node to see limits."
                : "Waiting for a node to connect…"}
            </p>
          ) : (
            <>
              {pools.length === 0 && notices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No agent on the connected nodes reports subscription limits.
                </p>
              ) : null}
              {pools.map((pool) => (
                <PoolSection
                  dialogs={dialogs}
                  key={pool.agentId}
                  now={read.now}
                  pool={pool}
                  redeemed={load}
                  threads={threads}
                />
              ))}
              {notices.length > 0 ? (
                <Alert variant="warning">
                  <AlertTriangleIcon />
                  {notices.map((notice, index) => (
                    // The same text may come from two nodes.
                    // oxlint-disable-next-line react/no-array-index-key
                    <AlertTitle className="break-words" key={index}>
                      {notice}
                    </AlertTitle>
                  ))}
                </Alert>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
