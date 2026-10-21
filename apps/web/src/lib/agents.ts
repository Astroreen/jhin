// The defined agents of each connected node, kept current for Civilization
// mode's roster and agent page (docs/plans/agents.md, D614).
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
import type { Disposable } from "@jhin/sdk";

/** One node's agents and the status of each agent's current generation. */
export interface NodeAgents {
  readonly status: "loading" | "ready" | "unsupported" | "error";
  readonly agents: readonly AgentRecord[];
  /** The latest turn status of each current generation's thread, by thread id. */
  readonly turns: Readonly<Record<string, TurnStatus | undefined>>;
  readonly error?: string;
}

const LOADING: NodeAgents = { status: "loading", agents: [], turns: {} };
const UNSUPPORTED: NodeAgents = { status: "unsupported", agents: [], turns: {} };

const byId = (agents: readonly AgentRecord[]) =>
  agents.toSorted((a, b) => a.title.localeCompare(b.title) || a.agentId.localeCompare(b.agentId));

/** Applies one event of a node's `agents` stream (D609). */
export function applyAgentEvent(
  state: NodeAgents,
  event: { type: string; payload: unknown },
): NodeAgents {
  switch (event.type) {
    case AgentEvents.defined:
    case AgentEvents.updated: {
      const record = event.payload as AgentRecord;
      return {
        ...state,
        agents: byId([...state.agents.filter((item) => item.agentId !== record.agentId), record]),
      };
    }
    case AgentEvents.removed: {
      const { agentId } = event.payload as { agentId: string };
      return { ...state, agents: state.agents.filter((item) => item.agentId !== agentId) };
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
    id: string;
    generationOf?: string;
    lastTurn?: { status: TurnStatus };
  };
  if (thread.generationOf === undefined) return state;
  if (state.turns[thread.id] === thread.lastTurn?.status && thread.id in state.turns) return state;
  return { ...state, turns: { ...state.turns, [thread.id]: thread.lastTurn?.status } };
}

/** Where an agent is now (D608), from its record and its current generation's thread. */
export function statusOf(agent: AgentRecord, state: NodeAgents): AgentStatus {
  if (agent.stoppedAt !== undefined) return "stopped";
  if (agent.projectId === undefined) return "unavailable";
  const current = agent.generations.at(-1);
  if (current === undefined) return "idle";
  const status = state.turns[current.threadId];
  return agentStatusOf(status === undefined ? undefined : { status });
}

export const STATUS_LABELS: Readonly<Record<AgentStatus, string>> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for you",
  stopped: "Stopped",
  unavailable: "Unavailable",
};

/**
 * Follows the agents of every open connection: `agents.catalog`, then the
 * `agents` stream after its head, and the `threads` index for the status of
 * each current generation. A node without `agents.catalog` is `unsupported`.
 */
export function createAgentsStore(connections: Connections) {
  const states = new Map<string, NodeAgents>();
  const feeds = new Map<string, { client: NodeConnection["client"]; stop: () => void }>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, NodeAgents> = new Map();
  const changed = () => {
    snapshot = new Map(states);
    for (const listener of Array.from(listeners)) listener();
  };
  const set = (id: string, next: NodeAgents) => {
    if (states.get(id) === next) return;
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
    set(id, LOADING);
    void (async () => {
      try {
        const { head, agents } = await client.call<{ head: number; agents: AgentRecord[] }>(
          "agents.catalog",
          {},
        );
        if (stopped) return;
        // The status of each current generation, then its changes from the index.
        const turns: Record<string, TurnStatus | undefined> = {};
        await Promise.all(
          agents.map(async (agent) => {
            const current = agent.generations.at(-1);
            if (current === undefined) return;
            const found = await client
              .call<{ thread: { lastTurn?: { status: TurnStatus } } }>("threads.get", {
                threadId: current.threadId,
              })
              .catch(() => undefined);
            turns[current.threadId] = found?.thread.lastTurn?.status;
          }),
        );
        if (stopped) return;
        set(id, { status: "ready", agents: byId(agents), turns });
        const onError = (error: unknown) =>
          set(id, { ...(states.get(id) ?? LOADING), status: "error", error: String(error) });
        subscriptions.push(
          client.subscribe(AGENTS_STREAM, { after: head, onError }, (event) =>
            set(id, applyAgentEvent(states.get(id) ?? LOADING, event)),
          ),
        );
        const threadsHead = await client
          .call<{ head: number }>("threads.catalog", {})
          .then((catalog) => catalog.head)
          .catch(() => 0);
        if (stopped) return;
        subscriptions.push(
          client.subscribe(THREADS_STREAM, { after: threadsHead, onError }, (event) =>
            set(id, applyThreadEvent(states.get(id) ?? LOADING, event)),
          ),
        );
        if (stopped) for (const subscription of subscriptions) subscription.dispose();
      } catch (error) {
        if (stopped) return;
        const code = (error as { code?: unknown }).code;
        set(
          id,
          code === "COMMAND_NOT_FOUND" || code === -32601
            ? UNSUPPORTED
            : { ...LOADING, status: "error", error: String(error) },
        );
      }
    })();
  };

  const sync = () => {
    const open = connections.list().filter((connection) => connection.state === "open");
    for (const [id, feed] of feeds) {
      const connection = open.find((item) => item.id === id);
      if (connection === undefined || connection.client !== feed.client) {
        feed.stop();
        feeds.delete(id);
        states.delete(id);
        changed();
      }
    }
    for (const connection of open) if (!feeds.has(connection.id)) start(connection);
  };

  let watching: Disposable | undefined;
  return {
    /** Every followed node's agents, by connection id: the same object until one changes. */
    snapshot: () => snapshot,
    /** Reads one node again, e.g. after a command whose events have not arrived yet. */
    refresh(id: string) {
      const connection = connections.list().find((item) => item.id === id);
      feeds.get(id)?.stop();
      feeds.delete(id);
      if (connection?.state === "open") start(connection);
    },
    subscribe(listener: () => void): Disposable {
      listeners.add(listener);
      if (watching === undefined) {
        watching = connections.subscribe(sync);
        sync();
      }
      return {
        dispose: () => {
          listeners.delete(listener);
          if (listeners.size > 0) return;
          watching?.dispose();
          watching = undefined;
          for (const feed of feeds.values()) feed.stop();
          feeds.clear();
          states.clear();
          snapshot = new Map();
        },
      };
    },
  };
}

export type AgentsStore = ReturnType<typeof createAgentsStore>;
