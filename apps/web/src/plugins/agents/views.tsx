// The agents' roster and an agent's page (D614–D617), a chunk of their own
// (D440): the page loads them once Civilization mode shows them.
import type { AgentGeneration, AgentRecord, AgentStatus } from "@jhin/agent-api";
import {
  THREAD_TRANSCRIPT_SLOT,
  type Connections,
  type Navigation,
  type NodeConnection,
  type ThreadsCatalog,
  type ThreadTranscriptProps,
} from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
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
  cn,
  type Toasts,
} from "@jhin/ui";
import {
  BotIcon,
  CircleStopIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useCatalog, useExternal } from "../../lib/hooks.ts";
import { CIVILIZATION_MODE } from "../../lib/modes.ts";
import {
  AGENT_FORM_PANEL,
  AGENT_PANEL,
  agentFormRoute,
  agentRoute,
  parseAgentSection,
} from "./route.ts";
import {
  STATUS_LABELS,
  createAgentsStore,
  generationRows,
  generationsKey,
  statusOf,
  type AgentsStore,
  type NodeAgents,
} from "./store.ts";

/** What the views use of the plugin that shows them. */
export interface AgentsView {
  readonly context: PluginContext;
  /** The agents store, made by this chunk on first use and disposed with the plugin. */
  readonly held: { store?: AgentsStore };
  readonly connections: Connections;
  readonly navigation: Navigation;
  readonly threads: ThreadsCatalog;
  readonly toasts: Toasts | undefined;
}

export const storeOf = (view: AgentsView): AgentsStore =>
  (view.held.store ??= createAgentsStore(view.connections, view.context.log));

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

function Muted({ children }: { children: string }) {
  return <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">{children}</p>;
}

// --- The roster (D614, D617) ---------------------------------------------------

/** One node's agents by home project, in the catalog's order of projects. */
function NodeRoster(props: {
  view: AgentsView;
  connection: NodeConnection;
  state: NodeAgents;
  labelled: boolean;
}) {
  const { view, connection, state } = props;
  const route = useExternal(view.navigation, view.navigation.current);
  const catalog = useCatalog(view.threads, { node: connection.id });
  const projects = catalog?.projects ?? [];
  const groups = new Map<string | undefined, AgentRecord[]>();
  for (const agent of state.agents) {
    const known = projects.some((project) => project.id === agent.projectId);
    const key = known ? agent.projectId : undefined;
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  const ordered = [
    ...projects
      .filter((project) => groups.has(project.id))
      .map((project) => ({ key: project.id, title: project.name })),
    ...(groups.has(undefined) ? [{ key: undefined, title: "No home project here" }] : []),
  ];
  const open = parseAgentSection(route.section);
  return (
    <div data-agents-node={connection.id}>
      {props.labelled ? (
        <p className="truncate px-2 pt-1 text-2xs font-medium uppercase tracking-wide text-sidebar-muted-foreground">
          {connection.label}
        </p>
      ) : null}
      {ordered.map((group) => (
        <div aria-label={group.title} key={group.key ?? ""} role="group">
          <p className="truncate px-2 pt-1 text-2xs text-sidebar-muted-foreground">{group.title}</p>
          <SidebarMenu>
            {groups.get(group.key)!.map((agent) => {
              const status = statusOf(agent, state);
              const active =
                route.panel === AGENT_PANEL &&
                route.node === connection.id &&
                open?.agentId === agent.agentId;
              return (
                <SidebarMenuItem key={agent.agentId}>
                  <SidebarMenuButton
                    aria-label={`${agent.title}, ${STATUS_LABELS[status]}`}
                    className="h-auto items-start py-1.5"
                    isActive={active}
                    onClick={() =>
                      void view.context.commands.execute("civilization.agent.open", {
                        node: connection.id,
                        agentId: agent.agentId,
                      })
                    }
                    title={STATUS_LABELS[status]}
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
            })}
          </SidebarMenu>
        </div>
      ))}
      {state.status === "error" ? (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-destructive-foreground">
          <span className="min-w-0 truncate">{state.error}</span>
          <Button onClick={() => storeOf(view).refresh(connection.id)} size="xs" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The `civilization.sidebar.agents` section: every open node's defined agents. */
export function Roster({ view }: { view: AgentsView }) {
  const nodes = useExternal(storeOf(view), storeOf(view).snapshot);
  const list = useExternal(view.connections, view.connections.list);
  const shown = list.filter((connection) => {
    const state = nodes.get(connection.id);
    return state !== undefined && state.status !== "unsupported";
  });
  const agents = shown.reduce(
    (count, connection) => count + (nodes.get(connection.id)?.agents.length ?? 0),
    0,
  );
  const failed = shown.some((connection) => nodes.get(connection.id)?.status === "error");
  // A new agent goes to the route's node, else the first that has agents (D1065).
  const route = useExternal(view.navigation, view.navigation.current);
  const target =
    shown.find((connection) => connection.id === route.node) ??
    shown.find((connection) => (nodes.get(connection.id)?.agents.length ?? 0) > 0) ??
    shown[0];
  const add =
    target === undefined ? null : (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            className="text-sidebar-muted-foreground"
            isActive={route.panel === AGENT_FORM_PANEL && route.section === undefined}
            onClick={() => view.navigation.navigate(agentFormRoute(target.id))}
          >
            <PlusIcon />
            <span>New agent</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  if (agents === 0 && !failed) {
    const loading = shown.some((connection) => nodes.get(connection.id)?.status === "loading");
    return (
      <>
        <Muted>{loading ? "Loading agents…" : "No agents yet."}</Muted>
        {loading ? null : add}
      </>
    );
  }
  return (
    <>
      {shown.map((connection) => (
        <NodeRoster
          connection={connection}
          key={connection.id}
          labelled={shown.length > 1}
          state={nodes.get(connection.id)!}
          view={view}
        />
      ))}
      {add}
    </>
  );
}

// --- An agent's page (D614, D615) ------------------------------------------------

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

function Generations(props: {
  view: AgentsView;
  node: string;
  agent: AgentRecord;
  state: NodeAgents;
  shown: AgentGeneration;
}) {
  const { view, node, agent, state, shown } = props;
  // Each generation's own status (D1272): `agents.generations`, asked again when this agent changes.
  const [statuses, setStatuses] = useState<
    { key: string; map: ReadonlyMap<string, AgentStatus> | "failed" } | undefined
  >();
  const key = `${node}|${agent.agentId}|${generationsKey(agent, state)}`;
  useEffect(() => {
    let live = true;
    view.threads
      .call<{ threadId: string; status: AgentStatus }[]>({ node }, "agents.generations", {
        agentId: agent.agentId,
      })
      .then(
        (rows) =>
          live && setStatuses({ key, map: new Map(rows.map((row) => [row.threadId, row.status])) }),
        () => live && setStatuses({ key, map: "failed" }),
      );
    return () => {
      live = false;
    };
  }, [view.threads, key]);
  // The last answer stands while the next one is read.
  const known = statuses?.map === "failed" ? undefined : statuses?.map;
  const rows = generationRows(agent, known);
  return (
    <nav aria-label="Generations" className="w-52 shrink-0 overflow-y-auto border-r p-2">
      {statuses?.map === "failed" ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">Statuses are unavailable.</p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {rows.map(({ generation, current, status }) => {
          const selected = generation.threadId === shown.threadId;
          return (
            <li key={generation.threadId}>
              <button
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex w-full cursor-pointer flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  selected && "bg-accent",
                )}
                onClick={() =>
                  view.navigation.navigate(
                    agentRoute(node, agent.agentId, current ? undefined : generation.number),
                  )
                }
                type="button"
              >
                <span className="flex items-center gap-1.5">
                  {status === undefined ? null : <StatusDot status={status} />}
                  <span>
                    Generation {generation.number}
                    {current ? " · current" : ""}
                  </span>
                  {status === undefined ? null : (
                    <span className="ms-auto text-xs text-muted-foreground">
                      {STATUS_LABELS[status]}
                    </span>
                  )}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {generation.reason ?? new Date(generation.startedAt).toLocaleString()}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * An agent's page in `civilization.views` (D614): who it is, its status, stop
 * and resume, and its generations, each readable through `thread.transcript`
 * with no composer: a generation is observed, not driven (D741).
 */
export function AgentPage(props: {
  view: AgentsView;
  node: string;
  agentId: string;
  generation?: number | undefined;
}) {
  const { view, node, agentId } = props;
  const nodes = useExternal(storeOf(view), storeOf(view).snapshot);
  const state = nodes.get(node);
  const agent = state?.agents.find((item) => item.agentId === agentId);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  if (state === undefined || state.status === "loading") {
    return <PageEmpty text="Loading the agent…" title={agentId} />;
  }
  if (state.status === "unsupported") {
    return <PageEmpty text="This node shows no agents to this client." title="No agents here" />;
  }
  if (agent === undefined) {
    return (
      <PageEmpty
        text="This node has no defined agent with that id. It may have been removed."
        title="No such agent"
      />
    );
  }
  const status = statusOf(agent, state);
  const shown =
    props.generation === undefined
      ? agent.generations.at(-1)
      : agent.generations.find((generation) => generation.number === props.generation);
  const run = async (
    command: "agents.stop" | "agents.resume" | "agents.rotate" | "agents.remove",
    failure: string,
    input: Record<string, unknown> = {},
  ) => {
    setBusy(true);
    try {
      await view.threads.call({ node }, command, { agentId, ...input });
      return true;
    } catch (error) {
      view.toasts?.show({ type: "error", title: failure, description: (error as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };
  // A new generation starts on the owner's word; the page follows it (D1066).
  const rotate = async () => {
    if (
      await run("agents.rotate", "Could not start a new generation", {
        reason: "started by the owner",
      })
    ) {
      view.navigation.navigate(agentRoute(node, agentId));
    }
  };
  const remove = async () => {
    setRemoving(false);
    if (await run("agents.remove", "Could not remove the agent")) {
      view.navigation.navigate({ node, mode: CIVILIZATION_MODE });
    }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-agent-page={agentId}>
      <header className="flex flex-wrap items-start gap-3 border-b px-6 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <BotIcon className="size-4 shrink-0 text-muted-foreground" />
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
          <Button
            onClick={() => view.navigation.navigate(agentFormRoute(node, agentId))}
            size="compact"
            variant="outline"
          >
            <PencilIcon />
            Edit
          </Button>
          <Button
            disabled={busy || agent.stoppedAt !== undefined}
            onClick={() => void rotate()}
            size="compact"
            title="Start its next generation: a fresh thread that inherits its knowledge"
            variant="outline"
          >
            <RotateCwIcon />
            New generation
          </Button>
          {agent.stoppedAt === undefined ? (
            <Button
              disabled={busy}
              onClick={() => void run("agents.stop", "Could not stop the agent")}
              size="compact"
              variant="outline"
            >
              <CircleStopIcon />
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
            disabled={busy}
            onClick={() => setRemoving(true)}
            size="compact"
            variant="destructive-outline"
          >
            Remove
          </Button>
        </div>
        <AlertDialog onOpenChange={setRemoving} open={removing}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {agent.title}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its definition leaves the node's config. Its generations, threads and knowledge
                stay, readable as they are.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button onClick={() => void remove()} variant="destructive">
                Remove agent
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </header>
      {agent.generations.length === 0 ? (
        <PageEmpty
          text="Its first generation starts when work arrives for it, or with agents.rotate."
          title="No generation yet"
        />
      ) : shown === undefined ? (
        <PageEmpty
          text={`The agent has no generation ${props.generation}.`}
          title="No such generation"
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <Generations agent={agent} node={node} shown={shown} state={state} view={view} />
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4">
            <Slot
              name={THREAD_TRANSCRIPT_SLOT}
              props={{ target: { node }, threadId: shown.threadId } satisfies ThreadTranscriptProps}
            />
          </div>
        </div>
      )}
    </div>
  );
}
