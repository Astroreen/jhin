import type { Route } from "@jhin/client-api";

/** Civilization mode's id (D741, `jhin.civilization`). */
const CIVILIZATION_MODE = "civilization";
/** The route panel of an inbox item (D630). */
export const INBOX_PANEL = "inbox";

/** An inbox item's page: panel `inbox`, the item's message id as `section`. */
export function inboxRoute(node: string, messageId: string): Route {
  return { node, mode: CIVILIZATION_MODE, panel: INBOX_PANEL, section: messageId };
}

/**
 * Who sent it, short: an agent's id, "owner" or "a thread", and its node (a
 * long node id cut to its first 8 characters; the page shows the address).
 */
export function senderLabel(address: string): string {
  const match = /^jhin:\/\/([^/]+)\/(agents\/([^/]+)|owner|threads\/([^/]+))$/.exec(address);
  if (match === null) return address;
  const who = match[3] ?? (match[2] === "owner" ? "owner" : "a thread");
  const node = match[1]!.length > 12 ? match[1]!.slice(0, 8) : match[1]!;
  return `${who}@${node}`;
}
