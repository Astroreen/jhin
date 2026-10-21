import type { Logger } from "@jhin/sdk";
import {
  appendKeepingNewest,
  keepNewest,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";

/** The history of every queued config change and what became of it (D50). */
export const OUTBOX_STREAM = "mesh/outbox";
/**
 * Events of the history kept (D497): the changes still waiting live in
 * `storage.kv`, so older outcomes are never read again. Trimmed once the
 * pending set is built and after every `TRIM_EVERY`th append.
 */
export const OUTBOX_HISTORY = 1000;
const TRIM_EVERY = 100;
/** The changes still waiting, one key each: what a mesh change looks at. */
const PENDING = "jhin.mesh.outbox";
/** Set once the pending set has been built from an outbox written before it existed. */
const BUILT = { namespace: "jhin.mesh", key: "outbox" } as const;

export interface Patch {
  readonly layer: "node" | "project";
  readonly section: string;
  readonly values: Record<string, unknown>;
  /** Keys removed from the section, so they take their default again (D84). */
  readonly unset?: readonly string[];
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
   * nodes. Reads only the pending set, never the outbox stream. A call made
   * while a flush runs makes it run once more and resolves after that pass.
   */
  flush(): Promise<void>;
  /** What is still waiting (expiring what waited too long first), oldest first. */
  pending(): Promise<(PendingChange & { readonly expiresAt: number | null })[]>;
}

/**
 * The fan-out queue (D50). The `mesh/outbox` stream stays the append-only
 * history the UI reads; the changes still waiting live in `storage.kv`, so
 * looking for work costs the number of pending changes, not the length of the
 * history. A change ends as `mesh.config.delivered`, `.conflict`, `.failed` or
 * `.expired`, and leaves the pending set.
 */
export function createOutbox(options: OutboxOptions): Outbox {
  const { kv, log } = options;

  const onTrimError = (error: unknown) =>
    options.logger.warn("config outbox history not trimmed", { error: String(error) });
  const trim = () => keepNewest(log, OUTBOX_STREAM, OUTBOX_HISTORY).catch(onTrimError);
  /** Appends to the history, trimming it now and then. */
  const history = (type: string, payload: Json) =>
    appendKeepingNewest(log, OUTBOX_STREAM, [{ type, payload }], {
      keep: OUTBOX_HISTORY,
      every: TRIM_EVERY,
      onTrimError,
    });

  /**
   * Keys carry a number that only grows: queue time, but always above the last
   * key's, so changes queued in the same millisecond or after the clock stepped
   * back are still delivered in the order they were made in.
   */
  let last = 0;
  const nextKey = (id: string, queuedAt: number) => {
    last = Math.max(queuedAt, last + 1);
    return `${String(last).padStart(15, "0")}:${id}`;
  };

  // Outboxes written before the pending set existed: read the stream once and build it.
  async function prepare(): Promise<void> {
    const newestKey = async () => {
      const newest = (await kv.list(PENDING)).at(-1)?.key;
      const order = newest === undefined ? Number.NaN : Number(newest.split(":")[0]);
      if (Number.isFinite(order)) last = Math.max(last, order);
    };
    if ((await kv.get(BUILT.namespace, BUILT.key)) === undefined) {
      // A build that failed part way left some changes pending already: keep
      // those as they are, so every change is pending once.
      const taken = new Set(
        (await kv.list(PENDING)).map(({ value }) => (value as { id: string }).id),
      );
      await newestKey();
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
        if (finished.has(id) || taken.has(id)) continue;
        // The original queue time: one older than queueExpiryHours expires on the first look.
        const change: PendingChange = { id, node, patch, queuedAt: Date.parse(event.at) };
        await kv.set(PENDING, nextKey(id, change.queuedAt), change as unknown as Json);
      }
      await kv.set(BUILT.namespace, BUILT.key, { version: 1 });
    }
    await newestKey();
    // Only now: an outbox from before the pending set was read whole above.
    await trim();
  }
  // A failed preparation (a storage error) is tried again on the next call.
  let preparing: Promise<void> | undefined;
  const ready = () =>
    (preparing ??= prepare().catch((error: unknown) => {
      preparing = undefined;
      throw error;
    }));

  const finish = async (key: string, type: string, payload: Record<string, unknown>) => {
    // History first: a crash in between delivers the change again, which is harmless
    // for the node (same values, same time) but leaves two outcome events for one
    // id in the history; the other order could lose the outcome.
    await history(type, payload as Json);
    await kv.delete(PENDING, key);
  };

  /**
   * `finish` that never throws: a storage error leaves the change pending and
   * is logged, so one bad write does not stop the rest of the queue. The
   * change is then delivered again later, which is harmless (same values,
   * same time).
   */
  const record = async (key: string, type: string, payload: Record<string, unknown>) => {
    try {
      await finish(key, type, payload);
      return true;
    } catch (error) {
      options.logger.warn("config outbox could not record an outcome; the change stays pending", {
        type,
        id: String(payload["id"]),
        error: String(error),
      });
      return false;
    }
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
    await ready();
    const live: { key: string; change: PendingChange }[] = [];
    const now = options.now();
    for (const { key, value } of await kv.list(PENDING)) {
      const change = value as unknown as PendingChange;
      const deadline = expiresAt(change);
      if (deadline !== null && now >= deadline) {
        // Expired either way; if recording that fails, the next look records it.
        if (
          await record(key, "mesh.config.expired", {
            id: change.id,
            node: change.node,
            status: "expired",
            queuedAt: change.queuedAt,
            expiredAt: now,
          })
        )
          options.logger.warn("queued config change expired: its node never returned", {
            node: change.node,
            id: change.id,
          });
        continue;
      }
      // Not queued until its `mesh.config.queued` is in the history.
      if (!enqueuing.has(change.id)) live.push({ key, change });
    }
    return live;
  }

  /** Changes whose pending entry exists but whose `queued` event is still being written. */
  const enqueuing = new Set<string>();
  let running: Promise<void> | undefined;
  let again = false;
  function flush(): Promise<void> {
    if (running !== undefined) {
      // The running flush makes one more pass; resolve when that pass is done.
      again = true;
      return running;
    }
    running = deliverAll();
    return running;
  }
  async function deliverAll(): Promise<void> {
    // Cleared in the same step the loop ends, so a call arriving later starts
    // a new flush instead of joining one that already decided to stop.
    try {
      do {
        again = false;
        for (const { key, change } of await current()) {
          const { id, node, patch } = change;
          if (!options.reachable(node)) continue;
          // Only an error of the delivery itself makes the change failed;
          // errors recording the outcome are handled by `record`.
          let outcome: Delivery;
          try {
            outcome = await options.deliver(node, patch);
          } catch (error) {
            if (!options.unreachable(error))
              await record(key, "mesh.config.failed", { id, node, error: String(error) });
            continue;
          }
          await record(
            key,
            outcome.status === "conflict" ? "mesh.config.conflict" : "mesh.config.delivered",
            { id, node, ...outcome },
          );
          if (outcome.status === "conflict")
            options.logger.warn("queued config change lost to a newer one", { node, id });
        }
      } while (again);
    } finally {
      running = undefined;
    }
  }

  return {
    async enqueue(node, patch) {
      await ready();
      const change: PendingChange = { id: options.newId(), node, patch, queuedAt: options.now() };
      // Pending first: a crash in between leaves a change that is still delivered.
      // Until the `queued` event is written no flush sees it, so a change the
      // caller is told was not queued has not gone out either.
      const key = nextKey(change.id, change.queuedAt);
      enqueuing.add(change.id);
      try {
        await kv.set(PENDING, key, change as unknown as Json);
        try {
          await history("mesh.config.queued", change as unknown as Json);
        } catch (error) {
          await kv.delete(PENDING, key).catch((cleanup: unknown) =>
            options.logger.warn("config outbox could not withdraw a change it failed to queue", {
              id: change.id,
              error: String(cleanup),
            }),
          );
          throw error;
        }
      } finally {
        enqueuing.delete(change.id);
      }
      return change;
    },
    flush,
    async pending() {
      return (await current()).map(({ change }) => ({ ...change, expiresAt: expiresAt(change) }));
    },
  };
}
