import { DatabaseSync } from "node:sqlite";

import {
  StorageError,
  assertCount,
  assertEvents,
  assertName,
  createNotifier,
  parseStored,
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

/**
 * The smallest string greater than every string starting with `prefix`, in
 * code point order (SQLite's BINARY collation on UTF-8), or undefined when
 * there is none. Lets a prefix scan use the primary key index.
 */
function prefixUpperBound(prefix: string): string | undefined {
  const points = [...prefix];
  while (points.length > 0) {
    let code = points.pop()!.codePointAt(0)! + 1;
    if (code >= 0xd800 && code <= 0xdfff) code = 0xe000;
    if (code <= 0x10ffff) return points.join("") + String.fromCodePoint(code);
  }
  return undefined;
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
  payload: parseStored(row.payload, { stream: row.stream, sequence: Number(row.sequence) }),
  at: row.at,
});

function migrate(db: DatabaseSync): void {
  // IMMEDIATE takes the write lock first, so two processes opening the same
  // file cannot both run a migration; the version is re-read under the lock.
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    for (let index = version; index < MIGRATIONS.length; index += 1) db.exec(MIGRATIONS[index]!);
    if (version < MIGRATIONS.length) db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Opens (and migrates) the database at `file`; `":memory:"` works for tests. */
export function openSqliteStorage(file: string, now: () => Date = () => new Date()): SqliteStorage {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  migrate(db);

  const statements = {
    kvGet: db.prepare("SELECT value FROM kv WHERE namespace = ? AND key = ?"),
    kvSet: db.prepare(
      "INSERT INTO kv (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value",
    ),
    kvDelete: db.prepare("DELETE FROM kv WHERE namespace = ? AND key = ?"),
    kvListFrom: db.prepare(
      "SELECT key, value FROM kv WHERE namespace = ? AND key >= ? ORDER BY key",
    ),
    kvListRange: db.prepare(
      "SELECT key, value FROM kv WHERE namespace = ? AND key >= ? AND key < ? ORDER BY key",
    ),
    head: db.prepare("SELECT coalesce(max(sequence), 0) AS head FROM events WHERE stream = ?"),
    insert: db.prepare(
      "INSERT INTO events (stream, sequence, type, payload, at) VALUES (?, ?, ?, ?, ?)",
    ),
    read: db.prepare(
      "SELECT stream, sequence, type, payload, at FROM events WHERE stream = ? AND sequence > ? ORDER BY sequence LIMIT ?",
    ),
    streamsFrom: db.prepare(
      "SELECT stream, max(sequence) AS head FROM events WHERE stream >= ? GROUP BY stream ORDER BY stream",
    ),
    streamsRange: db.prepare(
      "SELECT stream, max(sequence) AS head FROM events WHERE stream >= ? AND stream < ? GROUP BY stream ORDER BY stream",
    ),
  };
  const notifier = createNotifier();
  const headOf = (stream: string) => Number((statements.head.get(stream) as { head: number }).head);

  const kv: KeyValueStore = {
    async get(namespace, key) {
      assertName("namespace", namespace);
      assertName("key", key);
      const row = statements.kvGet.get(namespace, key) as { value: string } | undefined;
      return row === undefined ? undefined : parseStored(row.value, { namespace, key });
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
      const upper = prefixUpperBound(prefix);
      const rows = (
        upper === undefined
          ? statements.kvListFrom.all(namespace, prefix)
          : statements.kvListRange.all(namespace, prefix, upper)
      ) as { key: string; value: string }[];
      return rows
        .filter((row) => row.key.startsWith(prefix))
        .map((row) => ({
          key: row.key,
          value: parseStored(row.value, { namespace, key: row.key }),
        }));
    },
  };

  const log: EventLog = {
    async append(stream, events: readonly NewEvent[], options = {}) {
      assertName("stream", stream);
      assertEvents(events);
      assertCount("expectedHead", options.expectedHead);
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
            { stream, head, expectedHead: options.expectedHead },
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
      notifier.notify(stored);
      return stored;
    },
    async read(stream, options = {}) {
      assertName("stream", stream);
      assertCount("after", options.after);
      assertCount("limit", options.limit);
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
      const upper = prefixUpperBound(prefix);
      const rows = (
        upper === undefined
          ? statements.streamsFrom.all(prefix)
          : statements.streamsRange.all(prefix, upper)
      ) as { stream: string; head: number }[];
      return rows
        .filter((row) => row.stream.startsWith(prefix))
        .map((row) => ({ stream: row.stream, head: Number(row.head) }));
    },
    subscribe(stream, listener) {
      assertName("stream", stream);
      return notifier.subscribe(stream, listener);
    },
  };

  return {
    kv,
    log,
    close: () => {
      notifier.clear();
      db.close();
    },
  };
}
