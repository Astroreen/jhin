// Where this device keeps the nodes it connects to (security.md D423): in
// IndexedDB, as T3 Code keeps saved remote environments
// (apps/web/src/connection/storage.ts), never in localStorage.

const DATABASE = "jhin.connections";
const STORE = "nodes";
const KEY = "list";
/** Where versions before D423 kept the nodes, tokens included. */
export const LEGACY_STORAGE_KEY = "jhin.nodes";

function request<T>(run: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode) {
  return new Promise<T>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore(STORE));
    opening.addEventListener("error", () => reject(opening.error));
    // Another tab holds an older version open: fail instead of waiting forever.
    opening.addEventListener("blocked", () =>
      reject(new Error("The saved nodes are held open by another tab")),
    );
    opening.addEventListener("success", () => {
      const database = opening.result;
      const transaction = database.transaction(STORE, mode);
      const pending = run(transaction.objectStore(STORE));
      transaction.addEventListener("complete", () => {
        database.close();
        resolve(pending.result);
      });
      transaction.addEventListener("error", () => {
        database.close();
        reject(transaction.error);
      });
      // A quota or constraint failure aborts without an `error` on the transaction.
      transaction.addEventListener("abort", () => {
        database.close();
        reject(transaction.error ?? new Error("Saving the nodes was aborted"));
      });
    });
  });
}

export interface NodeStore {
  /** What is saved; nodes saved in localStorage by an older version move here first. */
  load(): Promise<unknown>;
  save(nodes: unknown): Promise<void>;
  /** Fires when another tab of this origin saved. */
  onChange(listener: () => void): () => void;
}

export function createNodeStore(storage: Storage = localStorage): NodeStore {
  // Tabs of one origin tell each other about a save: IndexedDB has no "storage" event.
  const channel =
    typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(DATABASE);
  const save = async (nodes: unknown) => {
    await request((store) => store.put(nodes, KEY), "readwrite");
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel, not a window
    channel?.postMessage("saved");
  };
  return {
    async load() {
      const legacy = storage.getItem(LEGACY_STORAGE_KEY);
      if (legacy !== null) {
        let parsed: unknown = [];
        try {
          parsed = JSON.parse(legacy);
        } catch {
          // An unreadable entry moves as nothing rather than blocking the client.
        }
        const current = await request((store) => store.get(KEY), "readonly");
        // Nodes saved here already win; the old list only adds what is missing.
        const merged = [
          ...(Array.isArray(current) ? current : []),
          ...(Array.isArray(parsed) ? parsed : []),
        ];
        await save(merged);
        storage.removeItem(LEGACY_STORAGE_KEY);
      }
      return (await request((store) => store.get(KEY), "readonly")) ?? [];
    },
    save,
    onChange(listener) {
      if (channel === undefined) return () => {};
      const handler = () => listener();
      channel.addEventListener("message", handler);
      return () => channel.removeEventListener("message", handler);
    },
  };
}
