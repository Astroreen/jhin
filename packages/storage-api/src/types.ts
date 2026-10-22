import { DOTTED_ID, toDisposable, type Disposable } from "@jhin/sdk";

export const KV_CAPABILITY = "storage.kv";
export const EVENTLOG_CAPABILITY = "storage.eventlog";
/** `storage.blobs@1`: bytes beside the event log (attachments, screenshots, exports). */
export const BLOBS_CAPABILITY = "storage.blobs";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** `storage.kv@1`: namespaced JSON values. */
export interface KeyValueStore {
  get(namespace: string, key: string): Promise<Json | undefined>;
  set(namespace: string, key: string, value: Json): Promise<void>;
  /** Resolves `true` when the key existed. */
  delete(namespace: string, key: string): Promise<boolean>;
  /**
   * Entries of a namespace sorted by key in Unicode code point order (the
   * order of their UTF-8 bytes), optionally only keys starting with `prefix`.
   */
  list(namespace: string, options?: { prefix?: string }): Promise<{ key: string; value: Json }[]>;
}

export interface NewEvent {
  /** Namespaced lowercase dotted type: `agent.turn.started`. */
  readonly type: string;
  readonly payload: Json;
}

export interface StoredEvent extends NewEvent {
  readonly stream: string;
  /** Position in the stream: 1, 2, 3… without gaps. */
  readonly sequence: number;
  /** ISO 8601 time of the append. */
  readonly at: string;
}

/** A change to a `storage.kv` entry made together with an append (`storage.eventlog@1.1`). */
export type RecordWrite =
  | { readonly namespace: string; readonly key: string; readonly value: Json }
  | { readonly namespace: string; readonly key: string; readonly delete: true };

export interface AppendOptions {
  /** Optimistic concurrency: the append fails with CONFLICT unless the stream's head equals this. */
  readonly expectedHead?: number;
  /**
   * Since 1.1: entries of the `storage.kv` the same plugin provides (a provider
   * of `storage.eventlog@1.1` provides `storage.kv` too), written in
   * the same transaction as the events: all of them and the events are stored,
   * or nothing is. Lets a record and the event announcing it never disagree.
   */
  readonly records?: readonly RecordWrite[];
}

/**
 * `storage.eventlog@1`: append-only streams with per-stream sequences that
 * only grow by one. 1.2 can `trim` a stream's oldest events (D496), so a
 * reader resuming before the first kept one sees a gap.
 */
export interface EventLog {
  /**
   * Appends atomically: either every event is stored or none is. An empty
   * batch stores nothing and returns `[]`, but `expectedHead` is still checked.
   */
  append(
    stream: string,
    events: readonly NewEvent[],
    options?: AppendOptions,
  ): Promise<StoredEvent[]>;
  /**
   * Events with `sequence > after` (default 0), in order, at most `limit`
   * (default: all). Both must be non-negative integers.
   */
  read(stream: string, options?: { after?: number; limit?: number }): Promise<StoredEvent[]>;
  /** Sequence of the last event, 0 for an empty stream. */
  head(stream: string): Promise<number>;
  /** Non-empty streams in code point order, optionally only those starting with `prefix`. */
  streams(options?: { prefix?: string }): Promise<{ stream: string; head: number }[]>;
  /**
   * Receives every event appended after this call through this same instance,
   * in sequence order, even when a listener appends to the same stream while
   * handling an event. Appends made by another process sharing the storage are
   * not delivered; read them with `read`.
   */
  subscribe(stream: string, listener: (event: StoredEvent) => void): Disposable;
  /**
   * `storage.eventlog@1.2` (D496): forgets the events of `stream` with
   * `sequence <= through`, except the newest, which always stays, and
   * resolves how many it forgot. The head and the sequences of what is kept
   * do not change; a `read` after an older sequence starts at the first kept
   * event. A provider older than 1.2 has no `trim`.
   */
  trim?(stream: string, through: number): Promise<number>;
}

export interface BlobInfo {
  readonly key: string;
  readonly size: number;
  /** ISO 8601 time of the last write. */
  readonly modifiedAt: string;
}

/**
 * `storage.blobs@1`: byte strings under namespaced keys. A key is made of
 * `/`-separated segments, none empty, `.` or `..`. Blobs are written by
 * appending, so a large one is written in chunks as they arrive.
 */
export interface BlobStore {
  /**
   * Appends `bytes` to the blob (created when missing) and resolves with its
   * new size. With `offset`, the append fails with CONFLICT unless the blob's
   * size equals it, so a chunk sent twice is never written twice.
   */
  append(
    namespace: string,
    key: string,
    bytes: Uint8Array,
    options?: { offset?: number },
  ): Promise<number>;
  /** Bytes from `offset` (default 0), at most `length` (default: to the end); undefined when missing. */
  read(
    namespace: string,
    key: string,
    options?: { offset?: number; length?: number },
  ): Promise<Uint8Array | undefined>;
  stat(namespace: string, key: string): Promise<BlobInfo | undefined>;
  /** Renames a blob, replacing one at `to`; resolves `false` when `from` is missing. */
  move(namespace: string, from: string, to: string): Promise<boolean>;
  /** Resolves `true` when the blob existed. */
  delete(namespace: string, key: string): Promise<boolean>;
  /** Blobs of a namespace in key order, optionally only keys starting with `prefix`. */
  list(namespace: string, options?: { prefix?: string }): Promise<BlobInfo[]>;
  /**
   * The local file that holds a blob, for a program that reads files (an
   * agent); absent on stores that keep no files.
   */
  path?(namespace: string, key: string): string;
}

/** Checks a blob key: segments separated by `/`, none empty, `.` or `..`. */
export function assertBlobKey(key: string): void {
  assertName("key", key);
  if (key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new StorageError(
      "INVALID",
      "A blob key is made of non-empty segments other than . and ..",
      {
        key,
      },
    );
  }
}

export type StorageErrorCode = "CONFLICT" | "INVALID" | "CORRUPT";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: StorageErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.details = details;
  }
}

export function assertName(kind: "namespace" | "key" | "stream", value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageError("INVALID", `${kind} must be a non-empty string`, { [kind]: value });
  }
}

export function assertEvents(events: readonly NewEvent[]): void {
  for (const event of events) {
    if (!DOTTED_ID.test(event.type) || !event.type.includes(".")) {
      throw new StorageError(
        "INVALID",
        `Event type ${event.type} must be a namespaced lowercase dotted id`,
        {
          type: event.type,
        },
      );
    }
  }
}

/** Checks the records of an append before anything is written. */
export function assertRecords(records: readonly RecordWrite[]): void {
  for (const record of records) {
    assertName("namespace", record.namespace);
    assertName("key", record.key);
    if (!("delete" in record)) copyJson(record.value);
  }
}

export function assertCount(
  name: "after" | "limit" | "expectedHead" | "through" | "offset" | "length",
  value: number | undefined,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new StorageError("INVALID", `${name} must be a non-negative integer`, { [name]: value });
  }
}

/**
 * Trims `stream` down to its newest `count` events (D497). Resolves how many
 * were forgotten; 0 on a provider older than `storage.eventlog@1.2`, which cannot trim.
 */
export async function keepNewest(log: EventLog, stream: string, count: number): Promise<number> {
  if (log.trim === undefined) return 0;
  const head = await log.head(stream);
  return head > count ? log.trim(stream, head - count) : 0;
}

/**
 * Appends to a stream that keeps only its newest `keep` events (D497):
 * whenever an append ends on a multiple of `every`, the stream is trimmed,
 * and the append resolves after that. A failed trim is passed to `onTrimError`
 * and fails nothing: an untrimmed history only costs disk.
 */
export async function appendKeepingNewest(
  log: EventLog,
  stream: string,
  events: readonly NewEvent[],
  options: { keep: number; every: number; onTrimError(error: unknown): void },
): Promise<StoredEvent[]> {
  const stored = await log.append(stream, events);
  const first = stored[0]?.sequence;
  const last = stored.at(-1)?.sequence;
  // A batch may step over a multiple of `every` without ending on one.
  if (
    first !== undefined &&
    last !== undefined &&
    Math.floor(last / options.every) > Math.floor((first - 1) / options.every)
  ) {
    await keepNewest(log, stream, options.keep).catch(options.onTrimError);
  }
  return stored;
}

/** Code point order (= UTF-8 byte order), the one ordering every implementation uses. */
export function compareKeys(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Parses stored JSON; a corrupt row becomes a CORRUPT error naming where it came from. */
export function parseStored(text: string, where: Record<string, unknown>): Json {
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new StorageError("CORRUPT", "Stored value is not valid JSON", {
      ...where,
      error: String(error),
    });
  }
}

/**
 * Delivers appended events to subscribers in sequence order per stream. An
 * append made by a listener is queued behind the events still being delivered.
 */
export function createNotifier(): {
  subscribe(stream: string, listener: (event: StoredEvent) => void): Disposable;
  notify(events: readonly StoredEvent[]): void;
  clear(): void;
} {
  const listeners = new Map<string, Set<(event: StoredEvent) => void>>();
  const queue: StoredEvent[] = [];
  let draining = false;
  return {
    subscribe(stream, listener) {
      const set = listeners.get(stream) ?? new Set();
      set.add(listener);
      listeners.set(stream, set);
      return toDisposable(() => set.delete(listener));
    },
    notify(events) {
      queue.push(...events);
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const event = queue.shift()!;
          for (const listener of Array.from(listeners.get(event.stream) ?? [])) {
            try {
              listener({ ...event, payload: copyJson(event.payload) });
            } catch {
              // A failing subscriber must not fail the append that already happened.
            }
          }
        }
      } finally {
        draining = false;
      }
    },
    clear: () => listeners.clear(),
  };
}

/** Deep copy of a JSON value; also rejects values JSON cannot represent. */
export function copyJson<T extends Json>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) throw new StorageError("INVALID", "Value is not JSON-serialisable");
  return JSON.parse(text) as T;
}
