import { toDisposable } from "@jhin/sdk";

import {
  StorageError,
  assertEvents,
  assertName,
  copyJson,
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

/** In-memory `storage.kv` and `storage.eventlog`: same contract as the real ones, nothing persisted. */
export function createMemoryStorage(now: () => Date = () => new Date()): MemoryStorage {
  const values = new Map<string, Map<string, Json>>();
  const streams = new Map<string, StoredEvent[]>();
  const listeners = new Map<string, Set<(event: StoredEvent) => void>>();

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
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value: copyJson(value) }));
    },
  };

  const log: EventLog = {
    async append(stream, events, options = {}) {
      assertName("stream", stream);
      assertEvents(events);
      const existing = streams.get(stream) ?? [];
      if (options.expectedHead !== undefined && options.expectedHead !== existing.length) {
        throw new StorageError(
          "CONFLICT",
          `Stream ${stream} is at ${existing.length}, expected ${options.expectedHead}`,
          {
            stream,
            head: existing.length,
            expectedHead: options.expectedHead,
          },
        );
      }
      const at = now().toISOString();
      const stored: StoredEvent[] = events.map((event, index) => ({
        stream,
        sequence: existing.length + index + 1,
        type: event.type,
        payload: copyJson(event.payload),
        at,
      }));
      streams.set(stream, [...existing, ...stored]);
      for (const event of stored) {
        for (const listener of Array.from(listeners.get(stream) ?? [])) {
          try {
            listener(copyEvent(event));
          } catch {
            // A failing subscriber must not fail the append that already happened.
          }
        }
      }
      return stored.map(copyEvent);
    },
    async read(stream, options = {}) {
      assertName("stream", stream);
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
        .toSorted((a, b) => (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0));
    },
    subscribe(stream, listener) {
      assertName("stream", stream);
      const set = listeners.get(stream) ?? new Set();
      set.add(listener);
      listeners.set(stream, set);
      return toDisposable(() => set.delete(listener));
    },
  };

  return { kv, log };
}
