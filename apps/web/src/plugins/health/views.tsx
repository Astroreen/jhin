// Health in Civilization mode (docs/plans/agents.md, A7: D731), a chunk of its
// own (D440): the page loads it once Civilization mode shows it.
import type { EventRef, GroupStatus, Warning } from "@jhin/health-api";
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
import { useEffect, useState } from "react";

import { useExternal } from "../../lib/hooks.ts";
import { HEALTH_PANEL, detectorLabel, groupLabel, healthRoute } from "./route.ts";
import { openWarnings, type HealthStore } from "./store.ts";

/** What the views use of the plugin that shows them. */
export interface HealthView {
  readonly store: HealthStore;
  readonly connections: Connections;
  readonly navigation: Navigation;
  readonly toasts: Toasts | undefined;
}

/** The open warnings of every node in `civilization.sidebar.health`, newest first, and the overview. */
export function HealthList({ view }: { view: HealthView }) {
  const nodes = useExternal(view.store, view.store.snapshot);
  const route = useExternal(view.navigation, view.navigation.current);
  const warnings = openWarnings(nodes);
  const ready = [...nodes].filter(([, feed]) => feed.status === "ready").map(([node]) => node);
  const here = ready.includes(route.node ?? "") ? route.node! : ready[0];
  return (
    <SidebarMenu aria-label="Health">
      {here === undefined ? null : (
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={route.panel === HEALTH_PANEL && route.section === undefined}
            onClick={() => view.navigation.navigate(healthRoute(here))}
          >
            <ActivityIcon />
            <span>Ceremony and progress</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      {warnings.length === 0 ? (
        <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">No warnings.</p>
      ) : (
        warnings.map(({ node, warning }) => (
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
        ))
      )}
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

/** Calls a command of a node once per key, with its answer or error. */
function useCall<T>(view: HealthView, node: string, command: string, input: unknown, key: string) {
  const [result, setResult] = useState<{ key: string; value?: T; error?: string }>();
  useEffect(() => {
    const connection = view.connections.get(node);
    if (connection === undefined) return;
    let live = true;
    connection.client.call<T>(command, input).then(
      (value) => live && setResult({ key, value }),
      (error: unknown) => live && setResult({ key, error: errorText(error) }),
    );
    return () => {
      live = false;
    };
    // `key` names everything the call depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return result?.key === key ? result : undefined;
}

const RANK = { mission: 0, team: 1, project: 2, node: 3 } as const;

/** Ceremony against progress per group, over the window (D722). */
function Overview({ view, node }: { view: HealthView; node: string }) {
  const nodes = useExternal(view.store, view.store.snapshot);
  const head = Object.keys(nodes.get(node)?.value.warnings ?? {}).length;
  const status = useCall<{ windowHours: number; groups: GroupStatus[] }>(
    view,
    node,
    "health.status",
    {},
    `${node}|${head}`,
  );
  if (status === undefined) return <PageEmpty text="Reading the sensors…" title="Health" />;
  if (status.error !== undefined) return <PageEmpty text={status.error} title="Health" />;
  const { windowHours } = status.value!;
  // Narrowest first, as warnings are (D724).
  const groups = status.value!.groups.toSorted(
    (a, b) =>
      RANK[a.group.kind] - RANK[b.group.kind] ||
      groupLabel(a.group).localeCompare(groupLabel(b.group)),
  );
  return (
    <section
      aria-label="Ceremony and progress"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
    >
      <header>
        <h1 className="text-lg font-semibold">Ceremony and progress</h1>
        <p className="text-sm text-muted-foreground">
          The last {windowHours} hours. Ceremony: messages, asks, approvals, proof edits, queue
          changes. Progress: slices done, commits, merged pull requests.
        </p>
      </header>
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
  const payload = event.payload as {
    message?: { from?: string; to?: string; body?: string };
    slice?: { title?: string };
  } | null;
  if (payload?.message !== undefined) {
    const { from, to, body } = payload.message;
    return `${from} → ${to}: ${(body ?? "").trim().split("\n")[0]}`;
  }
  if (payload?.slice?.title !== undefined) return `Slice "${payload.slice.title}"`;
  return event.type;
}

type Detail = {
  warning: Warning;
  events: (EventRef & { payload: unknown; missing?: boolean })[];
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
    `${node}|${warningId}|${warning?.evidence.length ?? 0}`,
  );
  const [dismissing, setDismissing] = useState(false);
  if (feed === undefined || feed.status === "loading") {
    return <PageEmpty text="Reading the warnings…" title="Health" />;
  }
  if (warning === undefined) {
    return <PageEmpty text="The node no longer has this warning." title="No such warning" />;
  }
  const dismiss = async () => {
    const connection = view.connections.get(node);
    if (connection === undefined) return;
    setDismissing(true);
    try {
      await connection.client.call("health.warnings.dismiss", { warningId });
    } catch (error) {
      view.toasts?.show({
        type: "error",
        title: "Couldn't dismiss the warning",
        description: errorText(error),
      });
    } finally {
      setDismissing(false);
    }
  };
  const { analysis } = warning;
  return (
    <section
      aria-label="Health warning"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
    >
      <header className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">{detectorLabel(warning)}</h1>
        <Badge variant={warning.status === "open" ? "warning" : "secondary"}>
          {warning.status === "open" ? "Open" : "Dismissed"}
        </Badge>
      </header>
      <p className="max-w-3xl text-sm">{warning.summary}</p>
      <dl className="grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <dt>Group</dt>
        <dd>{groupLabel(warning.group)}</dd>
        <dt>Raised</dt>
        <dd>{new Date(warning.raisedAt).toLocaleString()}</dd>
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
            No agent has this work's context: set an analyst in the Health settings.
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
      {warning.status === "open" ? (
        <div>
          <Button disabled={dismissing} onClick={() => void dismiss()} variant="outline">
            Dismiss
          </Button>
        </div>
      ) : null}
      <section aria-label="Events behind it" className="flex max-w-3xl flex-col gap-1">
        <h2 className="text-sm font-medium">Events behind it</h2>
        {detail === undefined ? (
          <p className="text-sm text-muted-foreground">Reading the events…</p>
        ) : detail.error !== undefined ? (
          <p className="text-sm text-destructive">{detail.error}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {detail.value!.events.map((event) => (
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
                      {event.missing === true ? "Trimmed from the log" : describe(event)}
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
