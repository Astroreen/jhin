import {
  StorageError,
  assertCount,
  assertEvents,
  assertName,
  assertRecords,
  compareKeys,
  copyJson,
  createNotifier,
  assertBlobKey,
  type BlobInfo,
  type BlobStore,
  type EventLog,
  type Json,
  type KeyValueStore,
  type StoredEvent,
} from "./types.ts";

export interface MemoryStorage {
  readonly kv: KeyValueStore;
  readonly log: EventLog;
  /** Blobs in memory: no `path`, since no file holds them. */
  readonly blobs: BlobStore;
}

/** Sequences only grow and the newest event is never trimmed: the last one is the head. */
const headOf = (events: readonly StoredEvent[]) => events.at(-1)?.sequence ?? 0;

const copyEvent = (event: StoredEvent): StoredEvent => ({
  ...event,
  payload: copyJson(event.payload),
});

/** In-memory `storage.kv@1` and `storage.eventlog@1.1`: same contract as the real ones, nothing persisted. */
export function createMemoryStorage(now: () => Date = () => new Date()): MemoryStorage {
  const values = new Map<string, Map<string, Json>>();
  const streams = new Map<string, StoredEvent[]>();
  const notifier = createNotifier();

  const kv: KeyValueStore = {
    async get(namespace, key) {
      assertName("namespace", namespace);
      assertName("key", key);
      const value = values.get(namespace)?.get(key);
      return value === undefined ? undefined : copyJson(value);
    },
    async set(namespace, key, value) {
      assertName("namespace", namespace);
      assertName("key", key);
      const space = values.get(namespace) ?? new Map<string, Json>();
      space.set(key, copyJson(value));
      values.set(namespace, space);
    },
    async delete(namespace, key) {
      assertName("namespace", namespace);
      assertName("key", key);
      return values.get(namespace)?.delete(key) ?? false;
    },
    async list(namespace, options = {}) {
      assertName("namespace", namespace);
      const prefix = options.prefix ?? "";
      return [...(values.get(namespace) ?? [])]
        .filter(([key]) => key.startsWith(prefix))
        .toSorted(([a], [b]) => compareKeys(a, b))
        .map(([key, value]) => ({ key, value: copyJson(value) }));
    },
  };

  const log: EventLog = {
    async append(stream, events, options = {}) {
      assertName("stream", stream);
      assertEvents(events);
      assertCount("expectedHead", options.expectedHead);
      const records = options.records ?? [];
      assertRecords(records);
      const existing = streams.get(stream) ?? [];
      const head = headOf(existing);
      if (options.expectedHead !== undefined && options.expectedHead !== head) {
        throw new StorageError(
          "CONFLICT",
          `Stream ${stream} is at ${head}, expected ${options.expectedHead}`,
          { stream, head, expectedHead: options.expectedHead },
        );
      }
      // Nothing awaited from here on: the records and the events land together.
      for (const record of records) {
        if ("delete" in record) values.get(record.namespace)?.delete(record.key);
        else {
          const space = values.get(record.namespace) ?? new Map<string, Json>();
          space.set(record.key, copyJson(record.value));
          values.set(record.namespace, space);
        }
      }
      if (events.length === 0) return [];
      const at = now().toISOString();
      const stored: StoredEvent[] = events.map((event, index) => ({
        stream,
        sequence: head + index + 1,
        type: event.type,
        payload: copyJson(event.payload),
        at,
      }));
      streams.set(stream, [...existing, ...stored]);
      notifier.notify(stored);
      return stored.map(copyEvent);
    },
    async read(stream, options = {}) {
      assertName("stream", stream);
      assertCount("after", options.after);
      assertCount("limit", options.limit);
      const after = options.after ?? 0;
      const events = (streams.get(stream) ?? []).filter((event) => event.sequence > after);
      const limited = options.limit === undefined ? events : events.slice(0, options.limit);
      return limited.map(copyEvent);
    },
    async head(stream) {
      assertName("stream", stream);
      return headOf(streams.get(stream) ?? []);
    },
    async streams(options = {}) {
      const prefix = options.prefix ?? "";
      return [...streams]
        .filter(([stream, events]) => stream.startsWith(prefix) && events.length > 0)
        .map(([stream, events]) => ({ stream, head: headOf(events) }))
        .toSorted((a, b) => compareKeys(a.stream, b.stream));
    },
    subscribe(stream, listener) {
      assertName("stream", stream);
      return notifier.subscribe(stream, listener);
    },
    async trim(stream, through) {
      assertName("stream", stream);
      assertCount("through", through);
      const events = streams.get(stream) ?? [];
      // The newest event always stays: it carries the head.
      const kept = events.filter(
        (event, index) => event.sequence > through || index === events.length - 1,
      );
      if (kept.length === events.length) return 0;
      streams.set(stream, kept);
      return events.length - kept.length;
    },
  };

  const files = new Map<string, Map<string, { bytes: Uint8Array; modifiedAt: string }>>();
  const space = (namespace: string) => {
    assertName("namespace", namespace);
    const found = files.get(namespace) ?? new Map();
    files.set(namespace, found);
    return found;
  };
  const info = (key: string, blob: { bytes: Uint8Array; modifiedAt: string }): BlobInfo => ({
    key,
    size: blob.bytes.length,
    modifiedAt: blob.modifiedAt,
  });
  const blobs: BlobStore = {
    async append(namespace, key, bytes, options = {}) {
      assertBlobKey(key);
      assertCount("offset", options.offset);
      const all = space(namespace);
      const existing = all.get(key)?.bytes ?? new Uint8Array();
      if (options.offset !== undefined && options.offset !== existing.length) {
        throw new StorageError(
          "CONFLICT",
          `Blob ${key} has ${existing.length} bytes, expected ${options.offset}`,
          { key, size: existing.length, offset: options.offset },
        );
      }
      const next = new Uint8Array(existing.length + bytes.length);
      next.set(existing);
      next.set(bytes, existing.length);
      all.set(key, { bytes: next, modifiedAt: now().toISOString() });
      return next.length;
    },
    async read(namespace, key, options = {}) {
      assertBlobKey(key);
      assertCount("offset", options.offset);
      assertCount("length", options.length);
      const blob = space(namespace).get(key);
      if (blob === undefined) return undefined;
      const start = options.offset ?? 0;
      const end = options.length === undefined ? undefined : start + options.length;
      return blob.bytes.slice(start, end);
    },
    async stat(namespace, key) {
      assertBlobKey(key);
      const blob = space(namespace).get(key);
      return blob === undefined ? undefined : info(key, blob);
    },
    async move(namespace, from, to) {
      assertBlobKey(from);
      assertBlobKey(to);
      const all = space(namespace);
      const blob = all.get(from);
      if (blob === undefined) return false;
      all.delete(from);
      all.set(to, blob);
      return true;
    },
    async delete(namespace, key) {
      assertBlobKey(key);
      return space(namespace).delete(key);
    },
    async list(namespace, options = {}) {
      const prefix = options.prefix ?? "";
      return [...space(namespace)]
        .filter(([key]) => key.startsWith(prefix))
        .toSorted(([a], [b]) => compareKeys(a, b))
        .map(([key, blob]) => info(key, blob));
    },
  };

  return { kv, log, blobs };
}
