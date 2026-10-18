import type { Logger } from "@jhin/sdk";
import type { EventLog, Json, KeyValueStore } from "@jhin/storage-api";

/** The history of every queued config change and what became of it (D50). */
export const OUTBOX_STREAM = "mesh/outbox";
/** The changes still waiting, one key each: what a mesh change looks at. */
const PENDING = "jhin.mesh.outbox";
/** Set once the pending set has been built from an outbox written before it existed. */
const BUILT = { namespace: "jhin.mesh", key: "outbox" } as const;

export interface Patch {
  readonly layer: "node" | "project";
  readonly section: string;
  readonly values: Record<string, unknown>;
  readonly at: number;
}

export type Delivery =
  | { readonly status: "applied" }
  | { readonly status: "conflict"; readonly localAt: number };

interface PendingChange {
  readonly id: string;
  readonly node: string;
  readonly patch: Patch;
  /** When the change was queued (ms since the epoch). */
  readonly queuedAt: number;
}

export interface OutboxOptions {
  readonly kv: KeyValueStore;
  readonly log: EventLog;
  readonly now: () => number;
  /** A change still undelivered this long after it was queued expires; `null`: never. */
  readonly expireAfterMs: number | null;
  readonly reachable: (node: string) => boolean;
  readonly deliver: (node: string, patch: Patch) => Promise<Delivery>;
  /** Errors that mean "try again when the node is back" rather than "failed". */
  readonly unreachable: (error: unknown) => boolean;
  readonly newId: () => string;
  readonly logger: Logger;
}

export interface Outbox {
  /** Queues a change for `node`: `mesh.config.queued`, delivered when a route exists. */
  enqueue(node: string, patch: Patch): Promise<PendingChange>;
  /**
   * Expires what waited too long, then delivers what is pending for reachable
   * nodes. Reads only the pending set, never the outbox stream. Calls made
   * while a flush runs make it run once more.
   */
  flush(): Promise<void>;
  /** What is still waiting (expiring what waited too long first), oldest first. */
  pending(): Promise<(PendingChange & { readonly expiresAt: number | null })[]>;
}

/** Keys sort by queue time, so delivery keeps the order changes were made in. */
const keyOf = (change: PendingChange) =>
  `${String(change.queuedAt).padStart(15, "0")}:${change.id}`;

/**
 * The fan-out queue (D50). The `mesh/outbox` stream stays the append-only
 * history the UI reads; the changes still waiting live in `storage.kv`, so
 * looking for work costs the number of pending changes, not the length of the
 * history. A change ends as `mesh.config.delivered`, `.conflict`, `.failed` or
 * `.expired`, and leaves the pending set.
 */
export function createOutbox(options: OutboxOptions): Outbox {
  const { kv, log } = options;

  // Outboxes written before the pending set existed: read the stream once and build it.
  const ready = (async () => {
    if ((await kv.get(BUILT.namespace, BUILT.key)) !== undefined) return;
    const events = await log.read(OUTBOX_STREAM);
    const finished = new Set(
      events
        .filter((event) => event.type !== "mesh.config.queued")
        .map((event) => (event.payload as { id: string }).id),
    );
    for (const event of events) {
      if (event.type !== "mesh.config.queued") continue;
      const { id, node, patch } = event.payload as unknown as {
        id: string;
        node: string;
        patch: Patch;
      };
      if (finished.has(id)) continue;
      const change: PendingChange = { id, node, patch, queuedAt: Date.parse(event.at) };
      await kv.set(PENDING, keyOf(change), change as unknown as Json);
    }
    await kv.set(BUILT.namespace, BUILT.key, { version: 1 });
  })();

  const finish = async (key: string, type: string, payload: Record<string, unknown>) => {
    // History first: a crash in between delivers the change again, which is harmless
    // (same values, same time); the other order could lose the outcome.
    await log.append(OUTBOX_STREAM, [{ type, payload: payload as Json }]);
    await kv.delete(PENDING, key);
  };

  const expiresAt = (change: PendingChange) =>
    options.expireAfterMs === null ? null : change.queuedAt + options.expireAfterMs;

  // One look at a time, so a change is never expired twice.
  let looking: Promise<unknown> = Promise.resolve();
  const current = (): Promise<{ key: string; change: PendingChange }[]> => {
    const next = looking.then(look, look);
    looking = next.catch(() => undefined);
    return next;
  };

  /** Pending changes; those past their expiry are recorded as expired and left out. */
  async function look(): Promise<{ key: string; change: PendingChange }[]> {
    await ready;
    const live: { key: string; change: PendingChange }[] = [];
    const now = options.now();
    for (const { key, value } of await kv.list(PENDING)) {
      const change = value as unknown as PendingChange;
      const deadline = expiresAt(change);
      if (deadline !== null && now >= deadline) {
        await finish(key, "mesh.config.expired", {
          id: change.id,
          node: change.node,
          status: "expired",
          queuedAt: change.queuedAt,
          expiredAt: now,
        });
        options.logger.warn("queued config change expired: its node never returned", {
          node: change.node,
          id: change.id,
        });
        continue;
      }
      live.push({ key, change });
    }
    return live;
  }

  let delivering = false;
  let again = false;
  async function flush(): Promise<void> {
    if (delivering) {
      again = true;
      return;
    }
    delivering = true;
    try {
      do {
        again = false;
        for (const { key, change } of await current()) {
          const { id, node, patch } = change;
          if (!options.reachable(node)) continue;
          try {
            const outcome = await options.deliver(node, patch);
            await finish(
              key,
              outcome.status === "conflict" ? "mesh.config.conflict" : "mesh.config.delivered",
              { id, node, ...outcome },
            );
            if (outcome.status === "conflict")
              options.logger.warn("queued config change lost to a newer one", { node, id });
          } catch (error) {
            if (!options.unreachable(error))
              await finish(key, "mesh.config.failed", { id, node, error: String(error) });
          }
        }
      } while (again);
    } finally {
      delivering = false;
    }
  }

  return {
    async enqueue(node, patch) {
      await ready;
      const change: PendingChange = { id: options.newId(), node, patch, queuedAt: options.now() };
      // Pending first: a crash in between leaves a change that is still delivered.
      await kv.set(PENDING, keyOf(change), change as unknown as Json);
      await log.append(OUTBOX_STREAM, [
        { type: "mesh.config.queued", payload: change as unknown as Json },
      ]);
      return change;
    },
    flush,
    async pending() {
      return (await current()).map(({ change }) => ({ ...change, expiresAt: expiresAt(change) }));
    },
  };
}
