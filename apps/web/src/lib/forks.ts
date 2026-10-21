import type { ThreadRecord } from "@jhin/client-api";

/**
 * Whether a fork can be merged back, as the header's button has said since W2: it
 * has a turn that is not running (the node takes the fork's last ended turn of its
 * own, D226; a waiting turn may follow one that ended). After a rollback in the fork
 * the record may name a copied turn; the node then refuses with T3's "Complete a run
 * in this fork".
 */
export function forkRan(thread: ThreadRecord): boolean {
  const status = thread.lastTurn?.status;
  return status !== undefined && status !== "running";
}
