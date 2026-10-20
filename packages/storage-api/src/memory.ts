import {
  StorageError,
  assertCount,
  assertEvents,
  assertName,
  assertRecords,
  compareKeys,
  copyJson,
  createNotifier,
  type EventLog,
  type Json,
  type KeyValueStore,
  type StoredEvent,
} from "./types.ts";

export interface MemoryStorage {
  readonly kv: KeyValueStore;
  readonly log: EventLog;
}

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
      if (options.expectedHead !== undefined && options.expectedHead !== existing.length) {
        throw new StorageError(
          "CONFLICT",
          `Stream ${stream} is at ${existing.length}, expected ${options.expectedHead}`,
          { stream, head: existing.length, expectedHead: options.expectedHead },
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
        sequence: existing.length + index + 1,
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
      return streams.get(stream)?.length ?? 0;
    },
    async streams(options = {}) {
      const prefix = options.prefix ?? "";
      return [...streams]
        .filter(([stream, events]) => stream.startsWith(prefix) && events.length > 0)
        .map(([stream, events]) => ({ stream, head: events.length }))
        .toSorted((a, b) => compareKeys(a.stream, b.stream));
    },
    subscribe(stream, listener) {
      assertName("stream", stream);
      return notifier.subscribe(stream, listener);
    },
  };

  return { kv, log };
}
