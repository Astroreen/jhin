// The defined agents of each connected node, kept current for Civilization
// mode's roster and agent page (docs/plans/agents.md, D614–D616).
import {
  AGENTS_STREAM,
  AgentEvents,
  THREADS_STREAM,
  ThreadEvents,
  agentStatusOf,
  type AgentRecord,
  type AgentStatus,
  type TurnStatus,
} from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** One node's agents, and what their status is made of (D616). */
export interface NodeAgents {
  /** `unsupported`: the node has no `agents.catalog`, or may not read it. */
  readonly status: "loading" | "ready" | "unsupported" | "error";
  readonly agents: readonly AgentRecord[];
  /** The status each agent had when last read with `agents.get`, by agent id. */
  readonly read: Readonly<Record<string, AgentStatus>>;
  /** The latest turn status of generation threads since then, by thread id. */
  readonly turns: Readonly<Record<string, TurnStatus | undefined>>;
  readonly error?: string;
}

const LOADING: NodeAgents = { status: "loading", agents: [], read: {}, turns: {} };
const UNSUPPORTED: NodeAgents = { ...LOADING, status: "unsupported" };

/** Answers that say the node will not show agents to this client. */
const NO_AGENTS = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

const sorted = (agents: readonly AgentRecord[]) =>
  agents.toSorted((a, b) => a.title.localeCompare(b.title) || a.agentId.localeCompare(b.agentId));

/** Applies one event of a node's `agents` stream (D609). */
export function applyAgentEvent(
  state: NodeAgents,
  event: { type: string; payload: unknown },
): NodeAgents {
  switch (event.type) {
    // A generation, a stop and a resume are each followed by `updated` (D609).
    case AgentEvents.defined:
    case AgentEvents.updated: {
      const record = event.payload as AgentRecord;
      if (typeof record?.agentId !== "string") return state;
      return {
        ...state,
        agents: sorted([...state.agents.filter((item) => item.agentId !== record.agentId), record]),
      };
    }
    case AgentEvents.removed: {
      const agentId = (event.payload as { agentId?: unknown } | null)?.agentId;
      if (typeof agentId !== "string") return state;
      const { [agentId]: _gone, ...read } = state.read;
      return { ...state, agents: state.agents.filter((item) => item.agentId !== agentId), read };
    }
    default:
      return state;
  }
}

/** Applies one event of a node's `threads` index: the turn status of a generation's thread. */
export function applyThreadEvent(
  state: NodeAgents,
  event: { type: string; payload: unknown },
): NodeAgents {
  if (event.type !== ThreadEvents.threadCreated && event.type !== ThreadEvents.threadUpdated) {
    return state;
  }
  const thread = event.payload as {
    id?: unknown;
    generationOf?: unknown;
    lastTurn?: { status: TurnStatus };
  } | null;
  if (typeof thread?.id !== "string" || thread.generationOf === undefined) return state;
  const status = thread.lastTurn?.status;
  if (thread.id in state.turns && state.turns[thread.id] === status) return state;
  return { ...state, turns: { ...state.turns, [thread.id]: status } };
}

/**
 * Where an agent is now (D608, D616): stopped by its record; unavailable as
 * the node last said (a runtime or home project missing); otherwise from its
 * current generation's thread, followed live in the `threads` index.
 */
export function statusOf(agent: AgentRecord, state: NodeAgents): AgentStatus {
  if (agent.stoppedAt !== undefined) return "stopped";
  const read = state.read[agent.agentId];
  if (read === "unavailable" || agent.projectId === undefined) return "unavailable";
  const current = agent.generations.at(-1);
  if (current === undefined) return "idle";
  if (current.threadId in state.turns) {
    const status = state.turns[current.threadId];
    return agentStatusOf(status === undefined ? undefined : { status });
  }
  return read === "working" || read === "waiting" ? read : "idle";
}

export const STATUS_LABELS: Readonly<Record<AgentStatus, string>> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for you",
  stopped: "Stopped",
  unavailable: "Unavailable",
};

export interface AgentsStore {
  /** Every followed node's agents, by connection id: the same map until one changes. */
  snapshot(): ReadonlyMap<string, NodeAgents>;
  /** Follows the open connections while subscribed. */
  subscribe(listener: () => void): Disposable;
  /** Reads a node again from the start, e.g. after a broken stream. */
  refresh(connection: string): void;
}

/**
 * Follows the agents of every open connection while somebody looks: the
 * head of the `threads` index, `agents.catalog`, each agent's `agents.get`,
 * then the `agents` stream after its head and the `threads` index after its
 * own. An agent that changes is read again with `agents.get`.
 */
export function createAgentsStore(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): AgentsStore & Disposable {
  const states = new Map<string, NodeAgents>();
  const feeds = new Map<string, { client: NodeConnection["client"]; stop: () => void }>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, NodeAgents> = new Map();
  const changed = () => {
    snapshot = new Map(states);
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        log.warn("an agents listener failed", { error: String(error) });
      }
    }
  };
  const set = (id: string, update: (state: NodeAgents) => NodeAgents) => {
    const known = states.get(id);
    if (known === undefined) return;
    const next = update(known);
    if (next === known) return;
    states.set(id, next);
    changed();
  };

  const start = (connection: NodeConnection) => {
    const { id, client } = connection;
    const subscriptions: Disposable[] = [];
    let stopped = false;
    feeds.set(id, {
      client,
      stop: () => {
        stopped = true;
        for (const subscription of subscriptions) subscription.dispose();
      },
    });
    states.set(id, LOADING);
    changed();
    const failed = (error: unknown) => {
      if (stopped) return;
      const code = String((error as { code?: unknown } | null)?.code);
      const message = error instanceof Error ? error.message : String(error);
      set(id, (state) =>
        NO_AGENTS.has(code) ? UNSUPPORTED : { ...state, status: "error", error: message },
      );
    };
    /** Each agent's latest read counts; an older answer is dropped. */
    const reads = new Map<string, number>();
    const read = (agentId: string) => {
      const number = (reads.get(agentId) ?? 0) + 1;
      reads.set(agentId, number);
      return client
        .call<AgentRecord & { status: AgentStatus }>("agents.get", { agentId })
        .then(({ status }) => {
          if (stopped || reads.get(agentId) !== number) return;
          set(id, (state) =>
            state.agents.some((agent) => agent.agentId === agentId)
              ? { ...state, read: { ...state.read, [agentId]: status } }
              : state,
          );
        })
        .catch((error: unknown) => {
          // The agent may be gone already; its status stays what the record says.
          if (!stopped) log.warn("could not read an agent", { agentId, error: String(error) });
        });
    };
    void (async () => {
      // The index's head first: whatever a generation does after it is followed.
      const { head: threadsHead } = await client.call<{ head: number }>("threads.catalog", {});
      const { head, agents } = await client.call<{ head: number; agents: AgentRecord[] }>(
        "agents.catalog",
        {},
      );
      if (stopped) return;
      set(id, () => ({ ...LOADING, status: "ready", agents: sorted(agents) }));
      await Promise.all(agents.map((agent) => read(agent.agentId)));
      if (stopped) return;
      subscriptions.push(
        client.subscribe(AGENTS_STREAM, { after: head, onError: failed }, (event) => {
          if (stopped) return;
          set(id, (state) => applyAgentEvent(state, event));
          const agentId = (event.payload as { agentId?: unknown } | null)?.agentId;
          if (
            (event.type === AgentEvents.defined || event.type === AgentEvents.updated) &&
            typeof agentId === "string"
          ) {
            void read(agentId);
          }
        }),
        client.subscribe(THREADS_STREAM, { after: threadsHead, onError: failed }, (event) => {
          if (!stopped) set(id, (state) => applyThreadEvent(state, event));
        }),
      );
    })().catch(failed);
  };

  const stop = (id: string) => {
    feeds.get(id)?.stop();
    feeds.delete(id);
    if (states.delete(id)) changed();
  };

  const sync = () => {
    const open = connections.list().filter((connection) => connection.state === "open");
    for (const [id, feed] of feeds) {
      const connection = open.find((item) => item.id === id);
      // What a closed or replaced connection showed is not live any more.
      if (connection === undefined || connection.client !== feed.client) stop(id);
    }
    for (const connection of open) if (!feeds.has(connection.id)) start(connection);
  };

  let watching: Disposable | undefined;
  const stopAll = () => {
    watching?.dispose();
    watching = undefined;
    for (const id of Array.from(feeds.keys())) stop(id);
  };
  return {
    snapshot: () => snapshot,
    refresh(id) {
      if (watching === undefined) return;
      stop(id);
      sync();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (watching === undefined) {
        watching = connections.subscribe(sync);
        sync();
      }
      return toDisposable(() => {
        listeners.delete(listener);
        // A subscriber back within the same tick (a re-render) keeps the feeds.
        queueMicrotask(() => {
          if (listeners.size === 0) stopAll();
        });
      });
    },
    dispose() {
      listeners.clear();
      stopAll();
    },
  };
}
