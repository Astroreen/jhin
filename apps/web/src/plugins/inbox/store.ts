// The owner's inbox on each connected node (docs/plans/agents.md, A2: D626,
// D630): the open messages and asks agents sent the owner, kept current from
// the `agents/inbox` stream.
import { INBOX_STREAM, MessageEvents, type InboxItem } from "@jhin/agent-api";
import type { Connections, MeshMembership } from "@jhin/client-api";
import type { Disposable } from "@jhin/sdk";

import type { MeshTarget } from "../../lib/mesh-targets.ts";

import {
  createNodeFeeds,
  newestToTell,
  type NodeFeed,
  type NodeFeeds,
} from "../../lib/node-feeds.ts";

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
  if (event.type === MessageEvents.inboxAnswered || event.type === MessageEvents.inboxDismissed) {
    const id = (event.payload as { messageId?: unknown } | null)?.messageId;
    if (!items.some((item) => item.message.messageId === id)) return items;
    return items.filter((item) => item.message.messageId !== id);
  }
  return items;
}

/**
 * Takes the `away` mark of every item `fresh` (a list read after a mesh
 * change) holds; an item it lacks keeps its mark, the stream decides whether
 * it is open. The same array when no mark moved.
 */
export function applyAwayMarks(
  items: readonly InboxItem[],
  fresh: readonly InboxItem[],
): readonly InboxItem[] {
  let moved = false;
  const next = items.map((item) => {
    const read = fresh.find((other) => other.message.messageId === item.message.messageId);
    if (read === undefined || (read.away === true) === (item.away === true)) return item;
    moved = true;
    const { away: _, ...rest } = item;
    return read.away === true ? { ...rest, away: true } : rest;
  });
  return moved ? next : items;
}

export type InboxStore = NodeFeeds<readonly InboxItem[]>;

/**
 * Follows the inbox of every open connection, and with `mesh` of every
 * reachable member of one (M1, D1530), for as long as the plugin runs,
 * so an ask is told to the owner in any mode: `agents.inbox.list`, then the
 * `agents/inbox` stream after its head. `arrived` hears each item that came
 * after the list, never the ones already waiting.
 */
export function createInboxStore(
  connections: Connections,
  log: {
    warn(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
  },
  arrived: (node: MeshTarget, item: InboxItem) => void,
  mesh?: MeshMembership,
): InboxStore & Disposable {
  return createNodeFeeds<readonly InboxItem[]>(
    connections,
    log,
    {
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
      // `away` is the node's reading of its mesh, never stored (D1549): a mesh
      // change reads the list again and only the marks are taken from it (D1565).
      meshChanged: applyAwayMarks,
      reread: (connection, before, after) => {
        const fresh = after
          .filter(
            (item) => !before.some((known) => known.message.messageId === item.message.messageId),
          )
          .toSorted((a, b) => b.message.sentAt.localeCompare(a.message.sentAt));
        for (const item of newestToTell(fresh, log, INBOX_STREAM)) arrived(connection, item);
      },
      seen: (connection, event, before, after) => {
        if (event.type === MessageEvents.received && after !== before)
          arrived(connection, after.at(-1)!);
      },
    },
    {},
    mesh,
  );
}

/** How many items are open on every node together (D1273). */
export function openCount(nodes: ReadonlyMap<string, NodeInbox>): number {
  let count = 0;
  for (const feed of nodes.values()) count += feed.value.length;
  return count;
}

/** The open items of every node, oldest first, with the key of the node each is on. */
export function openItems(
  nodes: ReadonlyMap<string, NodeInbox>,
): { readonly node: string; readonly item: InboxItem }[] {
  return [...nodes]
    .flatMap(([node, feed]) => feed.value.map((item) => ({ node, item })))
    .toSorted((a, b) => a.item.message.sentAt.localeCompare(b.item.message.sentAt));
}
