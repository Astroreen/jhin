// Civilization mode's agents (docs/plans/agents.md, A1: D614): the roster in
// the `civilization.sidebar.agents` slot and an agent's page in
// `civilization.views`, with its generations read through `thread.transcript`.
import type { AgentRecord, AgentStatus } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREAD_TRANSCRIPT_SLOT,
  THREADS_CAPABILITY,
  type Connections,
  type Navigation,
  type NodeConnection,
  type Route,
  type ThreadsCatalog,
  type ThreadTranscriptProps,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
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
  Slot,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  cn,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { BotIcon, PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { createAgentsStore, statusOf, STATUS_LABELS, type NodeAgents } from "../lib/agents.ts";
import { builtin } from "../lib/builtin.ts";
import { useExternal } from "../lib/hooks.ts";

/** The mode and route panel of an agent's page (D614). */
const CIVILIZATION_MODE = "civilization";
export const AGENT_PANEL = "agent";

/** The route of an agent's page: the agent in `section`, a generation's thread in `thread`. */
export const agentRoute = (node: string, agentId: string, threadId?: string): Route => ({
  node,
  mode: CIVILIZATION_MODE,
  panel: AGENT_PANEL,
  section: agentId,
  ...(threadId === undefined ? {} : { thread: threadId }),
});

const STATUS_DOT: Readonly<Record<AgentStatus, string>> = {
  idle: "bg-muted-foreground/40",
  working: "bg-info animate-pulse",
  waiting: "bg-warning",
  stopped: "bg-destructive/70",
  unavailable: "bg-muted-foreground/20",
};

const STATUS_BADGE: Readonly<
  Record<AgentStatus, "secondary" | "info" | "warning" | "error" | "outline">
> = {
  idle: "secondary",
  working: "info",
  waiting: "warning",
  stopped: "error",
  unavailable: "outline",
};

function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_DOT[status])}
    />
  );
}

export const agentsUiPlugin = builtin(
  "jhin.agents-ui",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const store = createAgentsStore(connections);

      /** Runs an agent command on its node; a failure shows as a toast. */
      const act = async (node: string, command: string, input: unknown, failure: string) => {
        try {
          return await threads.call({ node }, command, input);
        } catch (error) {
          toasts?.show({ type: "error", title: failure, description: (error as Error).message });
          return undefined;
        }
      };

      // --- The roster (D614) ---------------------------------------------------
      function AgentRow(props: {
        connection: NodeConnection;
        agent: AgentRecord;
        state: NodeAgents;
        active: boolean;
      }) {
        const { connection, agent, state } = props;
        const status = statusOf(agent, state);
        return (
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={`${agent.title}, ${STATUS_LABELS[status]}`}
              className="h-auto items-start py-1.5"
              isActive={props.active}
              onClick={() => navigation.navigate(agentRoute(connection.id, agent.agentId))}
            >
              <span className="mt-1.5 flex">
                <StatusDot status={status} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{agent.title}</span>
                {agent.role === undefined ? null : (
                  <span className="truncate text-xs text-sidebar-muted-foreground">
                    {agent.role}
                  </span>
                )}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      }

      function Roster() {
        const nodes = useExternal(store, store.snapshot);
        const list = useExternal(connections, connections.list);
        const route = useExternal(navigation, navigation.current);
        const shown = list.filter((connection) => {
          const state = nodes.get(connection.id);
          return state !== undefined && state.status !== "unsupported";
        });
        const total = shown.reduce(
          (count, connection) => count + (nodes.get(connection.id)?.agents.length ?? 0),
          0,
        );
        if (total === 0) {
          const loading = shown.some(
            (connection) => nodes.get(connection.id)?.status === "loading",
          );
          return (
            <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
              {loading
                ? "Loading agents…"
                : "No agents yet. Define one in the jhin.agents settings or with agents.define."}
            </p>
          );
        }
        return (
          <SidebarMenu>
            {shown.map((connection) => {
              const state = nodes.get(connection.id)!;
              return (
                <div key={connection.id}>
                  {shown.length > 1 ? (
                    <p className="px-2 pt-1 text-2xs uppercase tracking-wide text-sidebar-muted-foreground">
                      {connection.label}
                    </p>
                  ) : null}
                  {state.agents.map((agent) => (
                    <AgentRow
                      active={
                        route.panel === AGENT_PANEL &&
                        route.node === connection.id &&
                        route.section === agent.agentId
                      }
                      agent={agent}
                      connection={connection}
                      key={agent.agentId}
                      state={state}
                    />
                  ))}
                  {state.status === "error" ? (
                    <p className="px-2 py-1 text-xs text-destructive-foreground">{state.error}</p>
                  ) : null}
                </div>
              );
            })}
          </SidebarMenu>
        );
      }

      // --- An agent's page (D614) ------------------------------------------------
      function AgentPage({ node, agentId }: { node: string; agentId: string }) {
        const nodes = useExternal(store, store.snapshot);
        const route = useExternal(navigation, navigation.current);
        const state = nodes.get(node);
        const agent = state?.agents.find((item) => item.agentId === agentId);
        const [busy, setBusy] = useState(false);
        if (state === undefined || state.status === "loading") {
          return <PageEmpty text="Loading the agent…" title={agentId} />;
        }
        if (agent === undefined) {
          return (
            <PageEmpty
              text="This node has no agent with that id. It may have been removed."
              title="No such agent"
            />
          );
        }
        const status = statusOf(agent, state);
        const current = agent.generations.at(-1);
        const shownId = route.thread ?? current?.threadId;
        const shown = agent.generations.find((generation) => generation.threadId === shownId);
        const run = async (command: string, failure: string) => {
          setBusy(true);
          await act(node, command, { agentId }, failure);
          setBusy(false);
        };
        return (
          <div className="flex min-h-0 flex-1 flex-col" data-agent-page={agentId}>
            <header className="flex flex-wrap items-start gap-3 border-b px-6 py-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <BotIcon className="size-4 text-muted-foreground" />
                  <h1 className="truncate text-base font-semibold">{agent.title}</h1>
                  <Badge variant={STATUS_BADGE[status]}>{STATUS_LABELS[status]}</Badge>
                </div>
                {agent.role === undefined ? null : (
                  <p className="text-sm text-muted-foreground">{agent.role}</p>
                )}
                <p className="truncate font-mono text-xs text-muted-foreground/70">
                  {agent.address} · {agent.runtimeId}
                  {agent.model === undefined ? "" : ` · ${agent.model}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {agent.stoppedAt === undefined ? (
                  <Button
                    disabled={busy}
                    onClick={() => void run("agents.stop", "Could not stop the agent")}
                    size="compact"
                    variant="outline"
                  >
                    <PauseIcon />
                    Stop
                  </Button>
                ) : (
                  <Button
                    disabled={busy}
                    onClick={() => void run("agents.resume", "Could not resume the agent")}
                    size="compact"
                    variant="outline"
                  >
                    <PlayIcon />
                    Resume
                  </Button>
                )}
                <Button
                  disabled={busy || agent.stoppedAt !== undefined || agent.projectId === undefined}
                  onClick={() => void run("agents.rotate", "Could not start a new generation")}
                  size="compact"
                  variant="outline"
                >
                  <RefreshCwIcon />
                  {current === undefined ? "Start generation 1" : "New generation"}
                </Button>
              </div>
            </header>
            {agent.generations.length === 0 ? (
              <PageEmpty
                text="It starts its first generation when it is given work, or when you start one."
                title="No generation yet"
              />
            ) : (
              <div className="flex min-h-0 flex-1">
                <nav
                  aria-label="Generations"
                  className="w-48 shrink-0 overflow-y-auto border-r p-2"
                >
                  <ul className="flex flex-col gap-0.5">
                    {agent.generations.toReversed().map((generation) => (
                      <li key={generation.threadId}>
                        <button
                          aria-current={
                            generation.threadId === shown?.threadId ? "page" : undefined
                          }
                          className={cn(
                            "flex w-full cursor-pointer flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                            generation.threadId === shown?.threadId && "bg-accent",
                          )}
                          onClick={() =>
                            navigation.navigate(agentRoute(node, agentId, generation.threadId))
                          }
                          type="button"
                        >
                          <span>
                            Generation {generation.number}
                            {generation === current ? " · current" : ""}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {generation.reason ?? new Date(generation.startedAt).toLocaleString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
                <div className="min-h-0 flex-1 overflow-y-auto py-4">
                  {shown === undefined ? null : (
                    <Slot
                      name={THREAD_TRANSCRIPT_SLOT}
                      props={
                        {
                          target: { node },
                          threadId: shown.threadId,
                        } satisfies ThreadTranscriptProps
                      }
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        );
      }

      function PageEmpty({ title, text }: { title: string; text: string }) {
        return (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>{title}</EmptyTitle>
              <EmptyDescription>{text}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        );
      }

      function AgentView() {
        const route = useExternal(navigation, navigation.current);
        // Keeps the store following the nodes while the page is open.
        useExternal(store, store.snapshot);
        if (
          route.panel !== AGENT_PANEL ||
          route.node === undefined ||
          route.section === undefined
        ) {
          return null;
        }
        return <AgentPage agentId={route.section} key={route.node} node={route.node} />;
      }

      context.subscriptions.add(
        slots.contribute("civilization.sidebar.agents", {
          id: "jhin.agents-ui.roster",
          component: Roster,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.views", { id: "jhin.agents-ui.page", component: AgentView }),
      );
    },
  }),
);
