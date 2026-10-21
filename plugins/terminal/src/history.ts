// Terminal history files follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/terminal/Manager.ts (historyPath, readHistoryTail, readHistory,
// the coalesced persist worker and deleteHistory).
import * as Crypto from "node:crypto";
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
   * most, of what `content` returns when it runs; nothing when it returns
   * `undefined`.
   */
  write(threadId: string, terminalId: string, content: () => string | undefined): void;
  /** Deletes the session's file, after any write still pending for it. */
  delete(threadId: string, terminalId: string): Promise<void>;
  /** Runs every pending write now; resolves when they are done. */
  flush(): Promise<void>;
}

interface Pending {
  timer: ReturnType<typeof setTimeout> | undefined;
  content: () => string | undefined;
  /** The write running now, if any. */
  running: Promise<void> | undefined;
}

/**
 * A file name for an id, one per id: lowercase letters, digits and `-` stay,
 * anything else (`_`, `:`, `.`, capitals, which Windows folds or drops) is
 * `_` and its hex code. A name too long for a file system is a hash.
 */
export function historyName(id: string): string {
  const name = id.replace(
    /[^a-z0-9-]/g,
    (char) => `_${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
  return name.length <= 200 ? name : Crypto.createHash("sha256").update(id).digest("hex");
}

/**
 * History files under `dir`: `<dir>/<thread>/<terminal>.log`, by `historyName`.
 * Terminal output may hold secrets: the folders are the owner's only (0700),
 * the files too (0600). They are not encrypted.
 */
export function createHistoryFiles(dir: string, log: Logger): HistoryStore {
  const fileOf = (threadId: string, terminalId: string) =>
    Path.join(dir, historyName(threadId), `${historyName(terminalId)}.log`);
  const pending = new Map<string, Pending>();
  /** Deletes still running: a read of the same session waits for them. */
  const deleting = new Map<string, Promise<void>>();
  const key = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

  /**
   * Replaces a file at once: written beside it, then renamed over it, so a
   * crash mid-write keeps the old history. New files are the owner's only.
   */
  const replace = async (file: string, content: string) => {
    const folder = Path.dirname(file);
    await Fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Crypto.randomUUID()}.tmp`;
    try {
      await Fs.promises.writeFile(temporary, content, { mode: 0o600 });
      await Fs.promises.rename(temporary, file);
    } catch (error) {
      await Fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const run = (id: string, file: string, entry: Pending): Promise<void> => {
    entry.timer = undefined;
    const content = entry.content();
    const write = (async () => {
      await entry.running;
      if (content === undefined) return;
      try {
        await replace(file, content);
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
        await replace(file, history).catch((error: unknown) =>
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
      // Kept pending while the delete runs, so a write for these ids waits for it.
      const entry: Pending = pending.get(id) ?? {
        timer: undefined,
        content: () => undefined,
        running: undefined,
      };
      pending.set(id, entry);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined;
      const prior = entry.running;
      const file = fileOf(threadId, terminalId);
      const deleted = (async () => {
        await prior;
        await Fs.promises
          .rm(file, { force: true })
          .catch((error: unknown) =>
            log.warn("terminal history not deleted", { file, error: String(error) }),
          );
        // The thread's folder goes with its last terminal.
        await Fs.promises.rmdir(Path.dirname(file)).catch(() => undefined);
      })();
      // A write armed again meanwhile (the same ids opened again) runs after
      // the delete, and stays pending until then.
      entry.running = deleted;
      void deleted.finally(() => {
        if (entry.running === deleted) entry.running = undefined;
        if (entry.running === undefined && entry.timer === undefined && pending.get(id) === entry) {
          pending.delete(id);
        }
      });
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
