// The owner's inbox on each connected node (docs/plans/agents.md, A2: D626,
// D630): the open messages and asks agents sent the owner, kept current from
// the `agents/inbox` stream.
import { INBOX_STREAM, MessageEvents, type InboxItem } from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** One node's open items, oldest first. */
export interface NodeInbox {
  /** `unsupported`: the node has no `agents.inbox.list`, or this client may not read it. */
  readonly status: "loading" | "ready" | "unsupported" | "error";
  readonly items: readonly InboxItem[];
  readonly error?: string;
}

const LOADING: NodeInbox = { status: "loading", items: [] };
const UNSUPPORTED: NodeInbox = { status: "unsupported", items: [] };
const NO_INBOX = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/** Applies one event of a node's `agents/inbox` stream: open items come and go. */
export function applyInboxEvent(
  state: NodeInbox,
  event: { type: string; payload: unknown },
): NodeInbox {
  if (event.type === MessageEvents.received) {
    const item = event.payload as InboxItem | null;
    const id = item?.message?.messageId;
    if (typeof id !== "string" || item!.status !== "open") return state;
    if (state.items.some((known) => known.message.messageId === id)) return state;
    return { ...state, items: [...state.items, item!] };
  }
  if (event.type === MessageEvents.inboxAnswered) {
    const id = (event.payload as { messageId?: unknown } | null)?.messageId;
    if (!state.items.some((item) => item.message.messageId === id)) return state;
    return { ...state, items: state.items.filter((item) => item.message.messageId !== id) };
  }
  return state;
}

export interface InboxStore {
  /** Every connection's inbox, by connection id: the same map until one changes. */
  snapshot(): ReadonlyMap<string, NodeInbox>;
  subscribe(listener: () => void): Disposable;
}

/**
 * Follows the inbox of every open connection for as long as the plugin runs,
 * so an ask is told to the owner in any mode: `agents.inbox.list`, then the
 * `agents/inbox` stream after its head. `arrived` hears each item that came
 * after the list, never the ones already waiting.
 */
export function createInboxStore(
  connections: Connections,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
  arrived: (connection: NodeConnection, item: InboxItem) => void,
): InboxStore & Disposable {
  const states = new Map<string, NodeInbox>();
  const feeds = new Map<string, { client: NodeConnection["client"]; stop: () => void }>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, NodeInbox> = new Map();
  const changed = () => {
    snapshot = new Map(states);
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        log.warn("an inbox listener failed", { error: String(error) });
      }
    }
  };
  const set = (id: string, update: (state: NodeInbox) => NodeInbox) => {
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
      set(id, () =>
        NO_INBOX.has(code) ? UNSUPPORTED : { status: "error", items: [], error: message },
      );
    };
    void client
      .call<{ head: number; items: InboxItem[] }>("agents.inbox.list", {})
      .then(({ head, items }) => {
        if (stopped) return;
        set(id, () => ({ status: "ready", items }));
        subscriptions.push(
          client.subscribe(INBOX_STREAM, { after: head, onError: failed }, (event) => {
            if (stopped) return;
            const before = states.get(id);
            set(id, (state) => applyInboxEvent(state, event));
            const after = states.get(id);
            if (event.type === MessageEvents.received && after !== before) {
              arrived(connection, after!.items.at(-1)!);
            }
          }),
        );
      })
      .catch(failed);
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
  const watching = connections.subscribe(sync);
  sync();

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    dispose() {
      watching.dispose();
      listeners.clear();
      for (const id of Array.from(feeds.keys())) stop(id);
    },
  };
}

/** The open items of every node, oldest first, with the connection each is on. */
export function openItems(
  nodes: ReadonlyMap<string, NodeInbox>,
): { readonly node: string; readonly item: InboxItem }[] {
  return [...nodes]
    .flatMap(([node, state]) => state.items.map((item) => ({ node, item })))
    .toSorted((a, b) => a.item.message.sentAt.localeCompare(b.item.message.sentAt));
}
