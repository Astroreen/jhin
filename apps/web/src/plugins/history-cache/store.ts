// The history cache's IndexedDB database (loading.md D1588, D1609): what this
// device has read of each node's streams, kept per connection.
import type { CachedStream, StreamEvent } from "@jhin/client-api";

export const DATABASE = "jhin.history-cache";
const STREAMS = "streams";
const EVENTS = "events";

/** One kept stream, without its events. */
interface StreamEntry {
  readonly connection: string;
  readonly stream: string;
  readonly epoch: string;
  readonly lastSequence: number;
  /** When a thread last opened it (ms since the epoch); eviction goes by it (D1593). */
  readonly openedAt: number;
  /** About how much its events take: the UTF-8 size of their JSON. */
  readonly bytes: number;
}

export interface HistoryStore {
  read(connection: string, stream: string, now: number): Promise<CachedStream | undefined>;
  append(
    connection: string,
    stream: string,
    epoch: string,
    events: readonly StreamEvent[],
    now: number,
  ): Promise<void>;
  drop(connection?: string, stream?: string): Promise<void>;
  /** Every kept stream, without its events. */
  entries(): Promise<StreamEntry[]>;
  close(): void;
}

const promised = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

/** Settles once the transaction is stored; an abort (a quota, a constraint) rejects. */
const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new DOMException("The write was aborted", "AbortError")),
    );
  });

const utf8 = new TextEncoder();

/** The keys of every event of a stream. */
const eventRange = (connection: string, stream: string) =>
  IDBKeyRange.bound([connection, stream, 0], [connection, stream, Infinity]);

/** The keys of every stream (or event) of a connection. */
const connectionRange = (connection: string) =>
  IDBKeyRange.bound([connection], [connection, []], false, true);

export function openHistoryStore(factory: IDBFactory = indexedDB): HistoryStore {
  let opened: Promise<IDBDatabase> | undefined;
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DATABASE, 1);
      opening.addEventListener("upgradeneeded", () => {
        const db = opening.result;
        db.createObjectStore(STREAMS, { keyPath: ["connection", "stream"] });
        db.createObjectStore(EVENTS);
      });
      opening.addEventListener("error", () => {
        opened = undefined;
        reject(opening.error);
      });
      opening.addEventListener("blocked", () => {
        opened = undefined;
        reject(new Error("The history cache is held open by another tab"));
      });
      opening.addEventListener("success", () => {
        const db = opening.result;
        // A newer version in another tab: let it upgrade, open again next time.
        db.addEventListener("versionchange", () => {
          db.close();
          opened = undefined;
        });
        resolve(db);
      });
    }));

  const transaction = async (mode: IDBTransactionMode) =>
    (await database()).transaction([STREAMS, EVENTS], mode);

  return {
    async read(connection, stream, now) {
      const tx = await transaction("readwrite");
      const streams = tx.objectStore(STREAMS);
      const entry = (await promised(streams.get([connection, stream]))) as StreamEntry | undefined;
      if (entry === undefined) {
        await done(tx);
        return undefined;
      }
      const reading = promised(tx.objectStore(EVENTS).getAll(eventRange(connection, stream)));
      streams.put({ ...entry, openedAt: now } satisfies StreamEntry);
      const events = (await reading) as StreamEvent[];
      await done(tx);
      // Kept from 1 without a gap, or not at all (D1590).
      if (events.length !== entry.lastSequence || events.at(-1)?.sequence !== entry.lastSequence) {
        await this.drop(connection, stream);
        return undefined;
      }
      return { epoch: entry.epoch, lastSequence: entry.lastSequence, events };
    },

    async append(connection, stream, epoch, events, now) {
      if (events.length === 0) return;
      const tx = await transaction("readwrite");
      const streams = tx.objectStore(STREAMS);
      const store = tx.objectStore(EVENTS);
      const kept = (await promised(streams.get([connection, stream]))) as StreamEntry | undefined;
      // Another epoch is another database: what is kept is not its history.
      const entry = kept?.epoch === epoch ? kept : undefined;
      if (kept !== undefined && entry === undefined) store.delete(eventRange(connection, stream));
      const last = entry?.lastSequence ?? 0;
      const fresh = events.filter((event) => event.sequence > last);
      if (fresh.length > 0) {
        if (fresh.some((event, index) => event.sequence !== last + index + 1)) {
          // A gap: what would be kept is not the stream (D1590).
          streams.delete([connection, stream]);
          store.delete(eventRange(connection, stream));
        } else {
          let bytes = entry?.bytes ?? 0;
          for (const event of fresh) {
            store.put(event, [connection, stream, event.sequence]);
            bytes += utf8.encode(JSON.stringify(event)).length;
          }
          streams.put({
            connection,
            stream,
            epoch,
            lastSequence: fresh.at(-1)!.sequence,
            openedAt: entry?.openedAt ?? now,
            bytes,
          } satisfies StreamEntry);
        }
      } else if (kept !== undefined && entry === undefined) {
        streams.delete([connection, stream]);
      }
      await done(tx);
    },

    async drop(connection, stream) {
      const tx = await transaction("readwrite");
      const streams = tx.objectStore(STREAMS);
      const store = tx.objectStore(EVENTS);
      if (connection === undefined) {
        streams.clear();
        store.clear();
      } else if (stream === undefined) {
        streams.delete(connectionRange(connection));
        store.delete(connectionRange(connection));
      } else {
        streams.delete([connection, stream]);
        store.delete(eventRange(connection, stream));
      }
      await done(tx);
    },

    async entries() {
      const tx = await transaction("readonly");
      const all = (await promised(tx.objectStore(STREAMS).getAll())) as StreamEntry[];
      await done(tx);
      return all;
    },

    close() {
      void opened?.then((db) => db.close()).catch(() => undefined);
      opened = undefined;
    },
  };
}
