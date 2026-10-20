// Terminal history files follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/Manager.ts (historyPath, readHistoryTail, readHistory,
// the coalesced persist worker and deleteHistory).
import * as Fs from "node:fs";
import * as Path from "node:path";

import type { Logger } from "@jhin/sdk";

import { boundHistory, type HistoryLimits } from "./scrollback.ts";

/** How long output waits before its session's file is written (T3's debounce). */
const WRITE_DELAY_MS = 250;

/** Where a node keeps its terminals' output across restarts (D464). */
export interface HistoryStore {
  /** The kept output of a session from an earlier run, within the limits; "" when none. */
  read(threadId: string, terminalId: string, limits: HistoryLimits): Promise<string>;
  /**
   * Writes the session's output soon: one write per session per 250 ms at
   * most, of what `content` returns when it runs.
   */
  write(threadId: string, terminalId: string, content: () => string): void;
  /** Deletes the session's file, after any write still pending for it. */
  delete(threadId: string, terminalId: string): Promise<void>;
  /** Runs every pending write now; resolves when they are done. */
  flush(): Promise<void>;
}

interface Pending {
  timer: ReturnType<typeof setTimeout> | undefined;
  content: () => string;
  /** The write running now, if any. */
  running: Promise<void> | undefined;
}

/** History files under `dir`: `<dir>/<threadId>/<terminalId>.log`. */
export function createHistoryFiles(dir: string, log: Logger): HistoryStore {
  // Ids are stream parts (letters, digits, `. _ : -`, never `/`): safe as names,
  // but `:` is not allowed in Windows file names.
  const safe = (id: string) => id.replaceAll(":", "_");
  const fileOf = (threadId: string, terminalId: string) =>
    Path.join(dir, safe(threadId), `${safe(terminalId)}.log`);
  const pending = new Map<string, Pending>();
  /** Deletes still running: a read of the same session waits for them. */
  const deleting = new Map<string, Promise<void>>();
  const key = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

  const run = (id: string, file: string, entry: Pending): Promise<void> => {
    entry.timer = undefined;
    const content = entry.content();
    const write = (async () => {
      await entry.running;
      try {
        await Fs.promises.mkdir(Path.dirname(file), { recursive: true });
        await Fs.promises.writeFile(file, content);
      } catch (error) {
        log.warn("terminal history not written", { file, error: String(error) });
      }
    })();
    entry.running = write;
    void write.finally(() => {
      if (entry.running === write) entry.running = undefined;
      if (entry.running === undefined && entry.timer === undefined && pending.get(id) === entry) {
        pending.delete(id);
      }
    });
    return write;
  };

  return {
    async read(threadId, terminalId, limits) {
      // A terminal closed and opened again under the same ids must not read
      // the history its close is deleting.
      await deleting.get(key(threadId, terminalId));
      const file = fileOf(threadId, terminalId);
      let handle: Fs.promises.FileHandle;
      try {
        handle = await Fs.promises.open(file, "r");
      } catch {
        return "";
      }
      let raw: string;
      let cut: boolean;
      try {
        // Only the tail: a long log must not be read whole at startup.
        const { size } = await handle.stat();
        const offset = Math.max(0, size - limits.bytes);
        const bytes = Buffer.alloc(size - offset);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            length,
            bytes.length - length,
            offset + length,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        let start = 0;
        // A tail read can start inside a UTF-8 code point: skip its remaining bytes.
        if (offset > 0) while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
        raw = bytes.subarray(start, length).toString("utf8");
        cut = offset > 0;
      } finally {
        await handle.close();
      }
      const history = boundHistory(raw, limits);
      if (cut || history !== raw) {
        await Fs.promises
          .writeFile(file, history)
          .catch((error: unknown) =>
            log.warn("terminal history not capped", { file, error: String(error) }),
          );
      }
      return history;
    },
    write(threadId, terminalId, content) {
      const id = key(threadId, terminalId);
      const file = fileOf(threadId, terminalId);
      const entry = pending.get(id) ?? { timer: undefined, content, running: undefined };
      entry.content = content;
      pending.set(id, entry);
      if (entry.timer !== undefined) return;
      entry.timer = setTimeout(() => void run(id, file, entry), WRITE_DELAY_MS);
      entry.timer.unref?.();
    },
    delete(threadId, terminalId) {
      const id = key(threadId, terminalId);
      const deleted = (async () => {
        const entry = pending.get(id);
        if (entry !== undefined) {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          entry.timer = undefined;
          await entry.running;
          if (pending.get(id) === entry) pending.delete(id);
        }
        const file = fileOf(threadId, terminalId);
        await Fs.promises
          .rm(file, { force: true })
          .catch((error: unknown) =>
            log.warn("terminal history not deleted", { file, error: String(error) }),
          );
        // The thread's folder goes with its last terminal.
        await Fs.promises.rmdir(Path.dirname(file)).catch(() => undefined);
      })();
      deleting.set(id, deleted);
      void deleted.finally(() => {
        if (deleting.get(id) === deleted) deleting.delete(id);
      });
      return deleted;
    },
    async flush() {
      const writes: Promise<void>[] = [];
      for (const [id, entry] of pending) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          const [threadId = "", terminalId = ""] = id.split("\u0000");
          writes.push(run(id, fileOf(threadId, terminalId), entry));
        } else if (entry.running !== undefined) writes.push(entry.running);
      }
      await Promise.all(writes);
    },
  };
}
