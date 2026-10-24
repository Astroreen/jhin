import { ThreadEvents } from "@jhin/agent-api";
import type { CachedStream, HistoryCache, StreamEvent } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import type { Disposable } from "@jhin/sdk";

/** What `threads.get` says of the thread now: the node's epoch (absent on an older node) and the head. */
export interface StreamInfo {
  readonly epoch?: string;
  readonly head: number;
}

export interface FollowOptions {
  readonly client: Pick<RpcClient, "subscribe">;
  /** The history cache, when the thread may open from it (a thread of the connected node). */
  readonly cache: HistoryCache | undefined;
  readonly connection: string;
  readonly stream: string;
  /** Asks the node for the thread's epoch and head; a rejection with `THREAD_NOT_FOUND` means it is gone. */
  info(): Promise<StreamInfo>;
  /** Runs `flush` once later (the next frame); the function returned cancels it. */
  schedule(flush: () => void): () => void;
  /**
   * Events to fold, in order; `reset` says to drop what was folded before
   * them first (the cache was not to be trusted, D1590).
   */
  onBatch(events: readonly StreamEvent[], reset: boolean): void;
  onError(error: Error): void;
}

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

/**
 * Follows a thread's stream from what the history cache keeps of it
 * (loading.md D1589): the kept events are handed over at once, then the
 * stream is followed after the last of them and what arrives is kept too,
 * one write per batch. What cannot be trusted is dropped and the stream read
 * again from 0 (D1590): another epoch, a head lower than what is kept, an
 * event that is not the one after the last (D498), or a thread that is gone.
 * Without a cache it follows the stream from 0, as before the cache.
 */
export function followCachedStream(options: FollowOptions): Disposable {
  const { cache, connection, stream } = options;
  let disposed = false;
  let subscription: Disposable | undefined;
  let pending: StreamEvent[] = [];
  let reset = false;
  let cancel: (() => void) | undefined;
  /** The epoch to keep what arrives under; undefined while nothing is to be kept. */
  let keeping: string | undefined;
  /**
   * What arrived from 0 while the epoch is not known yet (a thread opened
   * before its creation reached the node): kept once it is.
   */
  let waiting: StreamEvent[] | undefined;
  const drop = () => void cache?.drop(connection, stream).catch(() => undefined);

  const flush = () => {
    cancel = undefined;
    const batch = pending;
    const resetting = reset;
    pending = [];
    reset = false;
    options.onBatch(batch, resetting);
    if (waiting !== undefined) waiting.push(...batch);
    else if (keeping !== undefined && batch.length > 0) {
      void cache?.append(connection, stream, keeping, batch).catch(() => undefined);
    }
  };
  /** Set when the node did not know the thread yet: the epoch is asked again at its first event. */
  let retry = false;
  /**
   * Waits for the epoch while the stream is followed from 0 and keeps what came
   * meanwhile once it is known. A thread the node does not know yet (its
   * creation is on its way) is asked about again at its first event.
   */
  const learn = (asking: Promise<StreamInfo>, again: boolean) => {
    waiting = [];
    void asking.then(
      (info) => {
        const kept = waiting;
        waiting = undefined;
        if (disposed || kept === undefined || info.epoch === undefined || !cache?.enabled()) return;
        keeping = info.epoch;
        if (kept.length > 0)
          void cache.append(connection, stream, keeping, kept).catch(() => undefined);
      },
      (error: unknown) => {
        if (again && codeOf(error) === "THREAD_NOT_FOUND" && waiting !== undefined) retry = true;
        else waiting = undefined;
      },
    );
  };
  const deliver = (event: StreamEvent) => {
    pending.push(event);
    cancel ??= options.schedule(flush);
  };
  /** Drops what was folded: the next batch starts over, even an empty one. */
  const startOver = () => {
    pending = [];
    reset = true;
    cancel ??= options.schedule(flush);
  };

  /** Bumped for every subscription, so the events of one given up are ignored. */
  let round = 0;
  const follow = (after: number) => {
    const mine = ++round;
    let last = after;
    const following = options.client.subscribe(
      stream,
      { after, onError: (error) => !disposed && mine === round && options.onError(error) },
      (event) => {
        if (disposed || mine !== round) return;
        if (retry) {
          retry = false;
          learn(options.info(), false);
        }
        if (event.sequence !== last + 1) {
          // A gap (D498): from the cache, start over from 0; from 0, keep nothing of it.
          drop();
          keeping = undefined;
          waiting = undefined;
          if (after > 0) {
            round += 1;
            subscription?.dispose();
            subscription = undefined;
            startOver();
            void start(false).catch((error: unknown) => options.onError(error as Error));
            return;
          }
        }
        last = event.sequence;
        // A deleted thread keeps nothing on the device.
        if (event.type === ThreadEvents.threadDeleted) {
          keeping = undefined;
          waiting = undefined;
          drop();
        }
        deliver(event);
      },
    );
    // Given up while it was made (a gap in what it delivered at once): end it now.
    if (mine === round) subscription = following;
    else following.dispose();
  };

  const start = async (fromCache: boolean) => {
    const enabled = cache?.enabled() === true;
    // Both at once: the kept events render while the node is asked.
    const asking = enabled ? options.info() : undefined;
    asking?.catch(() => undefined);
    let kept: CachedStream | undefined;
    if (fromCache && enabled) kept = await cache!.read(connection, stream).catch(() => undefined);
    if (disposed) return;
    if (kept === undefined) {
      // Nothing kept: follow from 0 at once, and keep it once the epoch is known.
      if (asking !== undefined) learn(asking, true);
      follow(0);
      return;
    }
    options.onBatch(kept.events, true);
    let info: StreamInfo | undefined;
    let notFound = false;
    try {
      info = await asking;
    } catch (error) {
      // Gone: what is kept of it goes too. Anything else: read it as before the cache.
      notFound = codeOf(error) === "THREAD_NOT_FOUND";
    }
    if (disposed) return;
    // A failed question (a dropped connection) proves nothing: what is kept is
    // followed, and nothing new is kept until the next open. Only an answer that
    // disagrees, or a thread that is gone, drops it.
    if (
      notFound ||
      (info !== undefined &&
        (info.epoch === undefined || info.epoch !== kept.epoch || info.head < kept.lastSequence))
    ) {
      drop();
      startOver();
      // Read again from 0 under the node's epoch, when it answered one.
      keeping = !notFound && cache?.enabled() === true ? info?.epoch : undefined;
      follow(0);
      return;
    }
    keeping = cache?.enabled() === true ? info?.epoch : undefined;
    follow(kept.lastSequence);
  };

  void start(true).catch((error: unknown) => !disposed && options.onError(error as Error));
  return {
    dispose() {
      disposed = true;
      subscription?.dispose();
      cancel?.();
    },
  };
}
