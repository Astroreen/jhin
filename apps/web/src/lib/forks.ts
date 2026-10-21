import type { ThreadRecord } from "@jhin/client-api";

/**
 * Whether a fork can be merged back: its latest turn ended, however it ended (the
 * node takes the fork's last ended turn of its own, D226). After a rollback in the
 * fork the record may name a copied turn; the node then refuses with T3's "Complete
 * a run in this fork".
 */
export function forkRan(thread: ThreadRecord): boolean {
  const status = thread.lastTurn?.status;
  return status !== undefined && status !== "running" && status !== "waiting";
}
