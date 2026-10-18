import { DatabaseSync } from "node:sqlite";

import { toDisposable } from "@jhin/sdk";
import {
  StorageError,
  assertEvents,
  assertName,
  type EventLog,
  type Json,
  type KeyValueStore,
  type NewEvent,
  type StoredEvent,
} from "@jhin/storage-api";

/** Schema versions; each entry upgrades from the previous `user_version`. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE kv (
     namespace TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (namespace, key)
   ) WITHOUT ROWID;
   CREATE TABLE events (
     stream TEXT NOT NULL,
     sequence INTEGER NOT NULL,
     type TEXT NOT NULL,
     payload TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (stream, sequence)
   ) WITHOUT ROWID;`,
];

export interface SqliteStorage {
  readonly kv: KeyValueStore;
  readonly log: EventLog;
  close(): void;
}

function serialize(value: Json): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new StorageError("INVALID", "Value is not JSON-serialisable");
  return text;
}

interface EventRow {
  stream: string;
  sequence: number;
  type: string;
  payload: string;
  at: string;
}

const toEvent = (row: EventRow): StoredEvent => ({
  stream: row.stream,
  sequence: Number(row.sequence),
  type: row.type,
  payload: JSON.parse(row.payload) as Json,
  at: row.at,
});

/** Opens (and migrates) the database at `file`; `":memory:"` works for tests. */
export function openSqliteStorage(file: string, now: () => Date = () => new Date()): SqliteStorage {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[index]!);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const statements = {
    kvGet: db.prepare("SELECT value FROM kv WHERE namespace = ? AND key = ?"),
    kvSet: db.prepare(
      "INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value",
    ),
    kvDelete: db.prepare("DELETE FROM kv WHERE namespace = ? AND key = ?"),
    kvList: db.prepare(
      "SELECT key, value FROM kv WHERE namespace = ? AND substr(key, 1, ?) = ? ORDER BY key",
    ),
    head: db.prepare("SELECT coalesce(max(sequence), 0) AS head FROM events WHERE stream = ?"),
    insert: db.prepare(
      "INSERT INTO events (stream, sequence, type, payload, at) VALUES (?, ?, ?, ?, ?)",
    ),
    read: db.prepare(
      "SELECT stream, sequence, type, payload, at FROM events WHERE stream = ? AND sequence > ? ORDER BY sequence LIMIT ?",
    ),
    streams: db.prepare(
      "SELECT stream, max(sequence) AS head FROM events WHERE substr(stream, 1, ?) = ? GROUP BY stream ORDER BY stream",
    ),
  };
  const listeners = new Map<string, Set<(event: StoredEvent) => void>>();
  const headOf = (stream: string) => Number((statements.head.get(stream) as { head: number }).head);

  const kv: KeyValueStore = {
    async get(namespace, key) {
      assertName("namespace", namespace);
      assertName("key", key);
      const row = statements.kvGet.get(namespace, key) as { value: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.value) as Json);
    },
    async set(namespace, key, value) {
      assertName("namespace", namespace);
      assertName("key", key);
      statements.kvSet.run(namespace, key, serialize(value));
    },
    async delete(namespace, key) {
      assertName("namespace", namespace);
      assertName("key", key);
      return Number(statements.kvDelete.run(namespace, key).changes) > 0;
    },
    async list(namespace, options = {}) {
      assertName("namespace", namespace);
      const prefix = options.prefix ?? "";
      return (
        statements.kvList.all(namespace, prefix.length, prefix) as { key: string; value: string }[]
      ).map((row) => ({ key: row.key, value: JSON.parse(row.value) as Json }));
    },
  };

  const log: EventLog = {
    async append(stream, events: readonly NewEvent[], options = {}) {
      assertName("stream", stream);
      assertEvents(events);
      const payloads = events.map((event) => serialize(event.payload));
      const at = now().toISOString();
      let stored: StoredEvent[];
      db.exec("BEGIN IMMEDIATE");
      try {
        const head = headOf(stream);
        if (options.expectedHead !== undefined && options.expectedHead !== head) {
          throw new StorageError(
            "CONFLICT",
            `Stream ${stream} is at ${head}, expected ${options.expectedHead}`,
            {
              stream,
              head,
              expectedHead: options.expectedHead,
            },
          );
        }
        stored = events.map((event, index) => {
          const sequence = head + index + 1;
          statements.insert.run(stream, sequence, event.type, payloads[index]!, at);
          return {
            stream,
            sequence,
            type: event.type,
            payload: JSON.parse(payloads[index]!) as Json,
            at,
          };
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      for (const event of stored) {
        for (const listener of Array.from(listeners.get(stream) ?? [])) {
          try {
            listener({ ...event, payload: JSON.parse(JSON.stringify(event.payload)) as Json });
          } catch {
            // A failing subscriber must not fail the append that already happened.
          }
        }
      }
      return stored;
    },
    async read(stream, options = {}) {
      assertName("stream", stream);
      const rows = statements.read.all(
        stream,
        options.after ?? 0,
        options.limit ?? -1,
      ) as unknown as EventRow[];
      return rows.map(toEvent);
    },
    async head(stream) {
      assertName("stream", stream);
      return headOf(stream);
    },
    async streams(options = {}) {
      const prefix = options.prefix ?? "";
      return (
        statements.streams.all(prefix.length, prefix) as { stream: string; head: number }[]
      ).map((row) => ({
        stream: row.stream,
        head: Number(row.head),
      }));
    },
    subscribe(stream, listener) {
      assertName("stream", stream);
      const set = listeners.get(stream) ?? new Set();
      set.add(listener);
      listeners.set(stream, set);
      return toDisposable(() => set.delete(listener));
    },
  };

  return {
    kv,
    log,
    close: () => {
      listeners.clear();
      db.close();
    },
  };
}
