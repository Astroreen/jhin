// Health in Civilization mode (docs/plans/agents.md, A7: D731), a chunk of its
// own (D440): the page loads it once Civilization mode shows it.
import { HealthEvents, type EventRef, type GroupStatus, type Warning } from "@jhin/health-api";
import type { Connections, Navigation } from "@jhin/client-api";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  type Toasts,
} from "@jhin/ui";
import { ActivityIcon, HeartPulseIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { holdsRead, notLive } from "../../lib/node-feeds.ts";
import { HEALTH_PANEL, detectorLabel, groupLabel, healthRoute } from "./route.ts";
import { openWarnings, type HealthStore, type NodeHealth } from "./store.ts";

/** What the views use of the plugin that shows them. */
export interface HealthView {
  readonly store: HealthStore;
  readonly connections: Connections;
  readonly navigation: Navigation;
  readonly toasts: Toasts | undefined;
  readonly log: { warn(message: string, fields?: Record<string, unknown>): void };
}

/** The open warnings of every node in `civilization.sidebar.health`, newest first, and the overview. */
export function HealthList({ view }: { view: HealthView }) {
  const nodes = useExternal(view.store, view.store.snapshot);
  const route = useExternal(view.navigation, view.navigation.current);
  const warnings = openWarnings(nodes);
  // A node whose stream failed after it was read still has its overview.
  const ready = [...nodes].filter(([, feed]) => holdsRead(feed)).map(([node]) => node);
  const stale = notLive(nodes);
  return (
    <SidebarMenu aria-label="Health">
      {stale.length === 0 ? null : (
        <p className="px-2 py-1 text-xs text-destructive">
          Not live: {stale.map((node) => view.connections.get(node)?.label ?? node).join(", ")}.
          What shows may be out of date.
        </p>
      )}
      {/* One overview per node with health; the node is named once there are several. */}
      {ready.map((node) => (
        <SidebarMenuItem key={node}>
          <SidebarMenuButton
            isActive={
              route.panel === HEALTH_PANEL && route.node === node && route.section === undefined
            }
            onClick={() => view.navigation.navigate(healthRoute(node))}
          >
            <ActivityIcon />
            <span className="truncate">
              Ceremony and progress
              {ready.length > 1 ? ` · ${view.connections.get(node)?.label ?? node}` : ""}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
      {warnings.length > 0 ? null : ready.length > 0 ? (
        <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">No warnings.</p>
      ) : (
        // Nothing read yet is not "all healthy".
        <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
          {[...nodes.values()].some((feed) => feed.status === "loading")
            ? "Reading health…"
            : [...nodes.values()].some((feed) => feed.status === "error")
              ? "Health could not be read yet."
              : "No node here reports health."}
        </p>
      )}
      {warnings.length === 0
        ? null
        : warnings.map(({ node, warning }) => (
            <SidebarMenuItem key={`${node}|${warning.warningId}`}>
              <SidebarMenuButton
                className="h-auto py-1.5"
                isActive={
                  route.panel === HEALTH_PANEL &&
                  route.node === node &&
                  route.section === warning.warningId
                }
                onClick={() => view.navigation.navigate(healthRoute(node, warning.warningId))}
              >
                <TriangleAlertIcon />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs text-sidebar-muted-foreground">
                    {groupLabel(warning.group)}
                  </span>
                  <span className="truncate">{detectorLabel(warning)}</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
    </SidebarMenu>
  );
}

function PageEmpty({ title, text }: { title: string; text: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HeartPulseIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a node's feed says when it has no health to show, or nothing. */
function FeedProblem({ feed }: { feed: NodeHealth | undefined }) {
  if (feed === undefined) return <PageEmpty text="This node is not connected." title="Health" />;
  if (feed.status === "loading") return <PageEmpty text="Reading the warnings…" title="Health" />;
  if (feed.status === "unsupported") {
    return (
      <PageEmpty
        text="This node has no health (jhin.health), or this client may not read it."
        title="No health here"
      />
    );
  }
  if (feed.status === "error") {
    return <PageEmpty text={feed.error ?? "Health could not be read."} title="Health" />;
  }
  return null;
}

/**
 * Calls a command of a node once per key, with its answer or error and when it
 * answered. A new key of the same `scope` keeps showing the last answer until
 * the new one arrives, so a refresh does not blank the page. Nothing is called
 * while `enabled` is false (a node that has not answered, or has no health).
 */
function useCall<T>(
  view: HealthView,
  node: string,
  command: string,
  input: unknown,
  key: string,
  { scope = key, enabled = true }: { scope?: string; enabled?: boolean } = {},
) {
  const [result, setResult] = useState<{
    key: string;
    scope: string;
    at: Date;
    /** The last answer of this scope, kept when a later read fails. */
    value?: T;
    error?: string;
  }>();
  // The call is named by what it calls, not only by the caller's key.
  // A replaced connection (same node, new client) is called again too.
  const client = view.connections.get(node)?.client;
  const call = `${node}|${command}|${JSON.stringify(input)}|${key}|${scope}`;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const connection = view.connections.get(node);
    const answer =
      connection === undefined
        ? Promise.reject(new Error("This node is not connected."))
        : connection.client.call<T>(command, input);
    answer.then(
      (value) => live && setResult({ key, scope, at: new Date(), value }),
      (error: unknown) =>
        live &&
        setResult((previous) => ({
          key,
          scope,
          at: new Date(),
          error: errorText(error),
          ...(previous?.scope === scope && previous.value !== undefined
            ? { value: previous.value }
            : {}),
        })),
    );
    return () => {
      live = false;
    };
    // `call` and the client name everything the call depends on.
  }, [call, client, enabled]);
  return result?.key === key || result?.scope === scope ? result : undefined;
}

const RANK = { mission: 0, team: 1, project: 2, node: 3 } as const;

/** Ceremony against progress per group, over the window (D722). */
function Overview({ view, node }: { view: HealthView; node: string }) {
  const nodes = useExternal(view.store, view.store.snapshot);
  const feed = nodes.get(node);
  const health = feed?.value;
  // Read again on every change of the node's health and on Refresh; the counts
  // themselves change with every message, so the page says when it read them.
  const [round, setRound] = useState(0);
  // A node whose stream failed after it was read still answers commands: its
  // overview is read and shown, marked not live, as the sidebar offers it.
  const ready = holdsRead(feed);
  const status = useCall<{ windowHours: number; groups: GroupStatus[] }>(
    view,
    node,
    "health.status",
    {},
    `${node}|${round}`,
    { scope: node, enabled: ready },
  );
  // Whether the read of this round has answered: changes while one is under
  // way make one more read when it does, not one read each.
  const answered = status?.key === `${node}|${round}`;
  // The health the last read was made for; none until the node is ready.
  const seen = useRef(ready ? health : undefined);
  const stale = useRef(false);
  useEffect(() => {
    if (!ready) {
      seen.current = undefined;
      stale.current = false;
      return;
    }
    // The first read once ready (on mount, or loading → ready) is the one
    // `enabled` starts: only a later change reads again.
    if (seen.current === undefined) {
      seen.current = health;
      return;
    }
    if (seen.current !== health) {
      seen.current = health;
      stale.current = true;
    }
    if (stale.current && answered) {
      stale.current = false;
      setRound((value) => value + 1);
    }
  }, [health, ready, answered]);
  if (!ready) return <FeedProblem feed={feed} />;
  if (status === undefined) return <PageEmpty text="Reading the sensors…" title="Health" />;
  // A read that failed after a good one keeps the table, marked.
  if (status.value === undefined) {
    return <PageEmpty text={status.error ?? "No answer."} title="Health" />;
  }
  const { windowHours } = status.value;
  // Narrowest first, as warnings are (D724).
  const groups = status.value.groups.toSorted(
    (a, b) =>
      RANK[a.group.kind] - RANK[b.group.kind] ||
      groupLabel(a.group).localeCompare(groupLabel(b.group)),
  );
  return (
    <section
      aria-label="Ceremony and progress"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
    >
      {feed?.status === "error" ? (
        <p className="text-xs text-destructive">
          Not live: {feed.error ?? "the node's health stream failed"}.{" "}
          {feed.retrying === true
            ? "It is read again within a minute, and what came meanwhile is told then; Refresh reads the counts now."
            : "It is not read again until the connection is: Refresh reads the counts now."}
        </p>
      ) : null}
      <header className="flex items-start gap-4">
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Ceremony and progress</h1>
          <p className="text-sm text-muted-foreground">
            The last {windowHours} hours, as of {status.at.toLocaleTimeString()}. Ceremony:
            messages, asks, approvals, proof edits, queue changes. Progress: slices done, commits,
            merged pull requests.
          </p>
        </div>
        <Button onClick={() => setRound((value) => value + 1)} size="sm" variant="outline">
          Refresh
        </Button>
      </header>
      {status.error === undefined ? null : (
        <p className="text-xs text-destructive">
          The last refresh failed: {status.error}. These are the counts read before.
        </p>
      )}
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing counted yet.</p>
      ) : (
        <table className="max-w-3xl text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-4 font-medium">Group</th>
              <th className="py-1 pr-4 text-right font-medium">Ceremony</th>
              <th className="py-1 pr-4 text-right font-medium">Progress</th>
              <th className="py-1 font-medium">By kind</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((row) => (
              <tr className="border-t" key={JSON.stringify(row.group)}>
                <td className="py-1 pr-4">{groupLabel(row.group)}</td>
                <td className="py-1 pr-4 text-right tabular-nums">{row.ceremony}</td>
                <td className="py-1 pr-4 text-right tabular-nums">{row.progress}</td>
                <td className="py-1 text-xs text-muted-foreground">
                  {Object.entries(row.byKind)
                    .map(([kind, count]) => `${kind} ${count}`)
                    .join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** One line on an event behind a warning: who wrote what, or which slice. */
function describe(event: EventRef & { payload: unknown }): string {
  // The record is whatever its stream holds: only strings are shown.
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const payload = (event.payload ?? {}) as {
    message?: { from?: unknown; to?: unknown; body?: unknown };
    slice?: { title?: unknown };
  };
  const message = typeof payload.message === "object" ? payload.message : undefined;
  if (message !== undefined && message !== null) {
    const body = (text(message.body) ?? "").trim().split("\n")[0];
    return `${text(message.from) ?? "?"} → ${text(message.to) ?? "?"}: ${body}`;
  }
  const title = typeof payload.slice === "object" ? text(payload.slice?.title) : undefined;
  if (title !== undefined) return `Slice "${title}"`;
  return event.type;
}

type Detail = {
  warning: Warning;
  events: (EventRef & { payload: unknown; missing?: boolean; withheld?: string })[];
};

/**
 * A warning in `civilization.views` (D731): what crossed which threshold,
 * what the analyst said, and the events behind it, each opening to its record.
 */
function WarningPage(props: { view: HealthView; node: string; warningId: string }) {
  const { view, node, warningId } = props;
  const nodes = useExternal(view.store, view.store.snapshot);
  const feed = nodes.get(node);
  const warning = feed?.value.warnings[warningId];
  const detail = useCall<Detail>(
    view,
    node,
    "health.warnings.get",
    { warningId },
    // The newest event behind it: it moves even once the evidence holds its 50.
    `${node}|${warningId}|${JSON.stringify(warning?.evidence.at(-1) ?? null)}`,
    // The list stays while the newer one is read.
    { scope: `${node}|${warningId}`, enabled: warning !== undefined },
  );
  const [dismissing, setDismissing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    // Set on every mount: StrictMode mounts, cleans up and mounts again.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A feed that failed after it was read keeps what it showed (`node-feeds`).
  if (warning === undefined) {
    // A feed that holds what it read knows the warning is gone, even when not live.
    if (!holdsRead(feed)) return <FeedProblem feed={feed} />;
    return <PageEmpty text="The node no longer has this warning." title="No such warning" />;
  }
  const dismiss = async () => {
    const connection = view.connections.get(node);
    if (connection === undefined) {
      view.toasts?.show({
        type: "error",
        title: "Couldn't dismiss the warning",
        description: "This node is not connected.",
      });
      return;
    }
    setDismissing(true);
    let dismissed: Warning;
    try {
      dismissed = await connection.client.call<Warning>("health.warnings.dismiss", { warningId });
    } catch (error) {
      view.toasts?.show({
        type: "error",
        title: "Couldn't dismiss the warning",
        description: errorText(error),
      });
      if (mounted.current) setDismissing(false);
      return;
    }
    // Dismissed, the button stays off: the answer takes the warning's "Open" away.
    // The answer says so at once, whether or not the stream's event follows.
    view.toasts?.show({ type: "success", title: "Warning dismissed" });
    // The feed learns it here, page and sidebar alike, even if no event
    // follows; the stream's own event folds to the same warning (D724). Its
    // failing is this client's, not the dismissal's: logged, not told.
    try {
      view.store.apply(node, {
        type: HealthEvents.warningDismissed,
        // The node's record, as its event would carry it (D724).
        payload: {
          warningId,
          ...(dismissed.dismissedAt === undefined ? {} : { dismissedAt: dismissed.dismissedAt }),
          ...(dismissed.dismissedAfter === undefined
            ? {}
            : { dismissedAfter: dismissed.dismissedAfter }),
        },
      });
    } catch (error) {
      view.log.warn("a dismissed warning did not apply here", { warningId, error: String(error) });
    }
  };
  const { analysis } = warning;
  const open = warning.status === "open";
  return (
    <section
      aria-label="Health warning"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
    >
      <header className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">{detectorLabel(warning)}</h1>
        <Badge variant={open ? "warning" : "secondary"}>
          {open ? "Open" : warning.status === "cleared" ? "Cleared" : "Dismissed"}
        </Badge>
      </header>
      {feed?.status === "error" ? (
        <p className="text-xs text-destructive">
          Not live: {feed.error ?? "the node's health stream failed"}.{" "}
          {feed.retrying === true
            ? "It is read again within a minute."
            : "It is not read again until the connection is."}
        </p>
      ) : null}
      <p className="max-w-3xl text-sm">{warning.summary}</p>
      <dl className="grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <dt>Group</dt>
        <dd>{groupLabel(warning.group)}</dd>
        <dt>Raised</dt>
        <dd>{new Date(warning.raisedAt).toLocaleString()}</dd>
        {warning.status === "cleared" ? (
          <>
            <dt>Cleared</dt>
            <dd>
              {warning.clearedReason === "under-threshold" || warning.clearedReason === undefined
                ? "back under the threshold"
                : warning.clearedReason}
              {warning.clearedAt === undefined
                ? null
                : `, ${new Date(warning.clearedAt).toLocaleString()}`}
            </dd>
          </>
        ) : null}
        {Object.entries(warning.measures).map(([name, value]) => (
          <div className="contents" key={name}>
            <dt className="capitalize">{name}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <section aria-label="Analysis" className="flex max-w-3xl flex-col gap-1">
        <h2 className="text-sm font-medium">Analysis</h2>
        {analysis === undefined ? (
          <p className="text-sm text-muted-foreground">Waiting for the analyst…</p>
        ) : analysis.status === "none" ? (
          <p className="text-sm text-muted-foreground">
            No agent has this work's context: in the node's `jhin.health` config, map this project's
            id (or `*` for every project) to an agent's address under `analysts`.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono break-all">{analysis.analyst}</span>
              {analysis.reason === "assignee" ? ", assigned the most slices" : null}
              {analysis.reason === "config" ? ", the configured analyst" : null}
            </p>
            <p className="text-sm whitespace-pre-wrap">
              {analysis.status === "answered"
                ? (analysis.answer ?? "No answer.")
                : `The ask failed: ${analysis.error ?? "unknown error"}`}
            </p>
          </>
        )}
      </section>
      {open ? (
        <div>
          <Button disabled={dismissing} onClick={() => void dismiss()} variant="outline">
            Dismiss
          </Button>
        </div>
      ) : null}
      <section aria-label="Events behind it" className="flex max-w-3xl flex-col gap-1">
        <h2 className="text-sm font-medium">Events behind it</h2>
        {detail?.error === undefined ? null : (
          <p className="text-sm text-destructive">
            {detail.value === undefined
              ? detail.error
              : `The last read failed: ${detail.error}. These are the events read before.`}
          </p>
        )}
        {detail === undefined ? (
          <p className="text-sm text-muted-foreground">Reading the events…</p>
        ) : detail.value === undefined ? null : (
          <ol className="flex flex-col gap-1">
            {detail.value.events.map((event) => (
              <li key={`${event.stream}#${event.sequence}`}>
                <details className="rounded-md border px-2 py-1 text-sm">
                  <summary className="flex cursor-pointer gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {new Date(event.at).toLocaleTimeString()}
                    </span>
                    {event.kind === undefined ? null : (
                      <Badge variant="secondary">{event.kind}</Badge>
                    )}
                    <span className="truncate">
                      {event.withheld !== undefined
                        ? `Needs ${event.withheld} to read`
                        : event.missing === true
                          ? "Trimmed from the log"
                          : describe(event)}
                    </span>
                  </summary>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {event.stream}#{event.sequence} {event.type}
                  </p>
                  <pre className="mt-1 max-h-64 overflow-auto text-xs">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

/** Health's page: the overview, or a warning when the route names one. */
export function HealthPage(props: { view: HealthView; node: string; warningId?: string }) {
  return props.warningId === undefined ? (
    <Overview node={props.node} view={props.view} />
  ) : (
    <WarningPage node={props.node} view={props.view} warningId={props.warningId} />
  );
}
