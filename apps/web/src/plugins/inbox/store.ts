// The owner's inbox on each connected node (docs/plans/agents.md, A2: D626,
// D630): the open messages and asks agents sent the owner, kept current from
// the `agents/inbox` stream.
import { INBOX_STREAM, MessageEvents, type InboxItem } from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

import { createNodeFeeds, type NodeFeed, type NodeFeeds } from "../../lib/node-feeds.ts";

/** One node's open items, oldest first. */
export type NodeInbox = NodeFeed<readonly InboxItem[]>;

/** Applies one event of a node's `agents/inbox` stream: open items come and go. */
export function applyInboxEvent(
  items: readonly InboxItem[],
  event: { type: string; payload: unknown },
): readonly InboxItem[] {
  if (event.type === MessageEvents.received) {
    const item = event.payload as InboxItem | null;
    const id = item?.message?.messageId;
    if (typeof id !== "string" || item!.status !== "open") return items;
    if (items.some((known) => known.message.messageId === id)) return items;
    return [...items, item!];
  }
  if (event.type === MessageEvents.inboxAnswered) {
    const id = (event.payload as { messageId?: unknown } | null)?.messageId;
    if (!items.some((item) => item.message.messageId === id)) return items;
    return items.filter((item) => item.message.messageId !== id);
  }
  return items;
}

export type InboxStore = NodeFeeds<readonly InboxItem[]>;

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
  return createNodeFeeds<readonly InboxItem[]>(connections, log, {
    empty: [],
    stream: INBOX_STREAM,
    load: async (client) => {
      const { head, items } = await client.call<{ head: number; items: InboxItem[] }>(
        "agents.inbox.list",
        {},
      );
      return { head, state: items };
    },
    apply: applyInboxEvent,
    reread: (connection, before, after) => {
      for (const item of after) {
        if (!before.some((known) => known.message.messageId === item.message.messageId)) {
          arrived(connection, item);
        }
      }
    },
    seen: (connection, event, before, after) => {
      if (event.type === MessageEvents.received && after !== before)
        arrived(connection, after.at(-1)!);
    },
  });
}

/** The open items of every node, oldest first, with the connection each is on. */
export function openItems(
  nodes: ReadonlyMap<string, NodeInbox>,
): { readonly node: string; readonly item: InboxItem }[] {
  return [...nodes]
    .flatMap(([node, feed]) => feed.value.map((item) => ({ node, item })))
    .toSorted((a, b) => a.item.message.sentAt.localeCompare(b.item.message.sentAt));
}
