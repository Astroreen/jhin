import { toDisposable, type Disposable, type Logger } from "@jhin/sdk";
import type { Json, StoredEvent } from "@jhin/storage-api";

/** `rpc.streams@1`: streams served from memory instead of the event log. */
export const LIVE_STREAMS_CAPABILITY = "rpc.streams";

/** What a subscription to a stream of the event log nobody guards needs (security.md D415). */
export const UNGUARDED_STREAM_PERMISSION = "events.read";

/** What a subscription reads a stream from: the event log, or a plugin's live streams. */
export interface StreamSource {
  /** Sequence of the last event, 0 for a stream without events. */
  head(stream: string): Promise<number>;
  /** Events with `sequence > after` that the source still holds, in order, at most `limit`. */
  read(stream: string, options?: { after?: number; limit?: number }): Promise<StoredEvent[]>;
  /** Every event appended after this call, in sequence order. */
  subscribe(stream: string, listener: (event: StoredEvent) => void): Disposable;
}

/** A source and who may read it. */
export interface ServedStream {
  readonly source: StreamSource;
  /** Permissions a caller must hold to subscribe (`*` holds all), as for a command. */
  readonly permissions: readonly string[];
}

/**
 * The live streams of a node: a plugin serves streams whose events it keeps
 * in memory (terminal output), and clients subscribe to them with
 * `rpc.subscribe` like to any stream of the event log.
 */
export interface LiveStreams {
  /**
   * Serves the stream `name`, or every stream starting with `name` when it
   * ends in `/`, from `source`; a subscriber needs `permissions`. A name
   * served twice is refused.
   */
  serve(
    name: string,
    source: StreamSource,
    options?: { readonly permissions?: readonly string[] },
  ): Disposable;
  /** What serves `stream`, or `undefined` when the event log does. */
  sourceOf(stream: string): ServedStream | undefined;
  /**
   * Since 1.1: a subscriber to the event log's stream `name`, or to every
   * stream starting with `name` when it ends in `/`, needs `permissions`.
   * A stream no guard names needs `events.read`. A name guarded twice is
   * refused.
   */
  guard(name: string, permissions: readonly string[]): Disposable;
  /** Since 1.1: what a subscriber to the event log's `stream` needs, when a guard says. */
  guardOf(stream: string): readonly string[] | undefined;
}

/** The entry for `stream`: its own name, else the longest prefix ending in `/`. */
function lookup<T>(entries: ReadonlyMap<string, T>, stream: string): T | undefined {
  const exact = entries.get(stream);
  if (exact !== undefined) return exact;
  // The longest prefix wins, so `terminal/` and `terminal/x/` can be served apart.
  let found: { name: string; value: T } | undefined;
  for (const [name, value] of entries) {
    if (!name.endsWith("/") || !stream.startsWith(name)) continue;
    if (found === undefined || name.length > found.name.length) found = { name, value };
  }
  return found?.value;
}

export function createLiveStreams(): LiveStreams {
  const sources = new Map<string, ServedStream>();
  const guards = new Map<string, readonly string[]>();
  return {
    serve(name, source, options = {}) {
      if (name.length === 0) throw new Error("A live stream needs a name");
      if (sources.has(name)) throw new Error(`The live stream ${name} is already served`);
      const served: ServedStream = { source, permissions: [...(options.permissions ?? [])] };
      sources.set(name, served);
      return toDisposable(() => {
        if (sources.get(name) === served) sources.delete(name);
      });
    },
    sourceOf: (stream) => lookup(sources, stream),
    guard(name, permissions) {
      if (name.length === 0) throw new Error("A guarded stream needs a name");
      if (guards.has(name)) throw new Error(`The stream ${name} is already guarded`);
      const entry = [...permissions];
      guards.set(name, entry);
      return toDisposable(() => {
        if (guards.get(name) === entry) guards.delete(name);
      });
    },
    guardOf: (stream) => lookup(guards, stream),
  };
}

/**
 * Streams kept in memory, for a plugin to serve through `rpc.streams@1`.
 * Sequences start at `firstSequence` (by default the current time in
 * microseconds), and a stream started later starts above every sequence
 * handed out before, so a client that resumes after the node restarted never
 * waits for sequences it already saw; within one instance they grow by one.
 * The owner decides what is kept: `drop` forgets the oldest events, `clear`
 * all of them; sequences keep counting either way.
 */
export interface MemoryStreams extends StreamSource {
  append(stream: string, type: string, payload: Json): StoredEvent;
  /**
   * The events still kept, oldest first: the stream's own array, not a copy,
   * so it follows `append`, `drop` and `remove` (until `clear` or `delete`
   * forgets it). Copy it to keep a snapshot.
   */
  events(stream: string): readonly StoredEvent[];
  /** Forgets the oldest `count` events of `stream`. */
  drop(stream: string, count: number): void;
  /** Forgets events of `stream` by sequence: one, or a set of them in one pass. */
  remove(stream: string, sequence: number | ReadonlySet<number>): void;
  /** Forgets every event of `stream`; its sequences keep counting. */
  clear(stream: string): void;
  /**
   * Forgets `stream` altogether, its head too: a stream of that name started
   * later begins above every sequence this instance handed out.
   */
  delete(stream: string): void;
}

export function createMemoryStreams(
  options: {
    firstSequence?: number;
    now?: () => string;
    /** Where a listener that throws is reported; it never reaches `append`'s caller. */
    log?: Pick<Logger, "warn">;
  } = {},
): MemoryStreams {
  /** The highest sequence handed out: a stream that starts (again) starts above it. */
  let highest = 0;
  const first = () => Math.max(options.firstSequence ?? Date.now() * 1000, highest + 1);
  const now = options.now ?? (() => new Date().toISOString());
  const kept = new Map<string, StoredEvent[]>();
  /** Last sequence per stream; kept after a stream is cleared, so it never goes back. */
  const heads = new Map<string, number>();
  const listeners = new Map<string, Set<(event: StoredEvent) => void>>();

  return {
    append(stream, type, payload) {
      const sequence = (heads.get(stream) ?? first() - 1) + 1;
      highest = Math.max(highest, sequence);
      heads.set(stream, sequence);
      const event: StoredEvent = { stream, sequence, type, payload, at: now() };
      const list = kept.get(stream);
      if (list === undefined) kept.set(stream, [event]);
      else list.push(event);
      // Each listener on its own: one that throws (a subscriber whose peer just
      // closed) neither keeps the others from the event nor fails the append.
      for (const listener of Array.from(listeners.get(stream) ?? [])) {
        try {
          listener(event);
        } catch (error) {
          options.log?.warn("a live stream listener failed", {
            stream,
            sequence,
            error: String(error),
          });
        }
      }
      return event;
    },
    events: (stream) => kept.get(stream) ?? [],
    drop(stream, count) {
      const list = kept.get(stream);
      if (list === undefined || count <= 0) return;
      list.splice(0, count);
      if (list.length === 0) kept.delete(stream);
    },
    remove(stream, sequence) {
      const list = kept.get(stream);
      if (list === undefined) return;
      const gone = typeof sequence === "number" ? new Set([sequence]) : sequence;
      // One pass, however many go, in place: the array `events` returned is
      // the one that changes, as with `drop` and `append`.
      let next = 0;
      for (const event of list) {
        if (!gone.has(event.sequence)) list[next++] = event;
      }
      list.length = next;
      if (list.length === 0) kept.delete(stream);
    },
    clear(stream) {
      kept.delete(stream);
    },
    delete(stream) {
      kept.delete(stream);
      heads.delete(stream);
    },
    async head(stream) {
      return heads.get(stream) ?? 0;
    },
    async read(stream, readOptions = {}) {
      const after = readOptions.after ?? 0;
      const found = (kept.get(stream) ?? []).filter((event) => event.sequence > after);
      return readOptions.limit === undefined ? found : found.slice(0, readOptions.limit);
    },
    subscribe(stream, listener) {
      let set = listeners.get(stream);
      if (set === undefined) {
        set = new Set();
        listeners.set(stream, set);
      }
      set.add(listener);
      return toDisposable(() => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(stream) === set) listeners.delete(stream);
      });
    },
  };
}
