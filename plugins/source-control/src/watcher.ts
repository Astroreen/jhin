// The sweep follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/orchestration-v2/PullRequestWatchReactor.ts (reading each watched pull
// request, stopping on merge, close and failed reads) and Orchestrator.ts (a wake queued
// after the thread's running turn).
import {
  PULL_REQUEST_WATCH_FAILURE_LIMIT,
  type PullRequestWatch,
  type ThreadPullRequest,
} from "@jhin/source-control-api";
import type { Json, KeyValueStore } from "@jhin/storage-api";

import { SourceControlError } from "./git.ts";
import type { Links } from "./links.ts";
import {
  closedMessage,
  evaluateWatch,
  startWatch,
  unreadableMessage,
  watchMessage,
  type WatchRead,
} from "./pr-watch.ts";

const NAMESPACE = "jhin.source-control";

/** What the watcher needs of a thread. */
interface WatchedThread {
  readonly archived: boolean;
  /** A turn runs or waits for the user: a wake waits for it to end. */
  readonly busy: boolean;
}

export interface WatcherDeps {
  readonly kv: KeyValueStore;
  readonly links: Links;
  /** The pull request's state now, or `undefined` when no forge here can read it. */
  read(threadId: string, link: ThreadPullRequest): Promise<WatchRead | undefined>;
  thread(threadId: string): Promise<WatchedThread | undefined>;
  /** Sends a message to the thread, starting a turn. */
  send(threadId: string, text: string): Promise<void>;
  warn(message: string, fields: Record<string, unknown>): void;
  /** The time a watch starts at (ISO 8601); the clock when absent. */
  now?(): string;
}

export interface Watcher {
  watch(
    threadId: string,
    link: ThreadPullRequest,
  ): Promise<{ watching: true; wasWatching: boolean }>;
  unwatch(
    threadId: string,
    link: ThreadPullRequest,
  ): Promise<{ watching: false; wasWatching: boolean }>;
  /** Reads every watched pull request (of one thread) now and wakes threads with news. */
  sweep(threadId?: string): Promise<{ checked: number; woken: number }>;
  /** A thread's turn ended: what waited for it is sent now. */
  idle(threadId: string): Promise<void>;
}

export function createWatcher(deps: WatcherDeps): Watcher {
  let sweeping: Promise<unknown> = Promise.resolve();
  const now = deps.now ?? (() => new Date().toISOString());
  /** A thread's queue of news is read and written by one task at a time. */
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const next = (queues.get(threadId) ?? Promise.resolve()).then(task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(threadId, settled);
    void settled.then(() => {
      if (queues.get(threadId) === settled) queues.delete(threadId);
    });
    return next;
  }

  const pending = async (threadId: string): Promise<string[]> => {
    const value = await deps.kv.get(NAMESPACE, `wake/${threadId}`);
    return Array.isArray(value) ? (value as string[]) : [];
  };

  /** Sends what waits for the thread, unless a turn runs: then it waits for that turn's end. */
  const flush = (threadId: string) =>
    serial(threadId, async () => {
      const waiting = await pending(threadId);
      if (waiting.length === 0) return;
      const thread = await deps.thread(threadId);
      if (thread === undefined || thread.archived) {
        await deps.kv.delete(NAMESPACE, `wake/${threadId}`);
        return;
      }
      if (thread.busy) return;
      try {
        await deps.send(threadId, waiting.join("\n\n"));
      } catch (error) {
        // A turn started meanwhile: the news waits for it.
        if ((error as { code?: unknown }).code === "TURN_IN_PROGRESS") return;
        // Anything else would fail again: said once, then dropped rather than retried forever.
        deps.warn("waking a thread failed", { threadId, error: String(error) });
      }
      await deps.kv.delete(NAMESPACE, `wake/${threadId}`);
    });

  /** Keeps `text` for the thread; `flush` sends it. */
  const enqueue = (threadId: string, text: string) =>
    serial(threadId, async () => {
      await deps.kv.set(NAMESPACE, `wake/${threadId}`, [
        ...(await pending(threadId)),
        text,
      ] as unknown as Json);
    });

  /**
   * Changes the watch the sweep read, as stored now: a watch unwatched,
   * restarted or unlinked meanwhile is left alone.
   */
  const changeWatch = (
    threadId: string,
    link: ThreadPullRequest,
    next: PullRequestWatch | undefined,
  ) =>
    deps.links.modify(threadId, link.key, (current) => {
      if (current.watch?.startedAt !== link.watch!.startedAt) return undefined;
      if (next !== undefined) return { ...current, watch: next };
      const { watch: _watch, ...rest } = current;
      return rest;
    });

  /** Reads one watched pull request; true when it has news for its thread. */
  const check = async (threadId: string, link: ThreadPullRequest): Promise<boolean> => {
    const watch = link.watch!;
    const thread = await deps.thread(threadId);
    // An archived thread wakes for nothing: its watch ends.
    if (thread === undefined || thread.archived) {
      await changeWatch(threadId, link, undefined);
      return false;
    }
    let read: WatchRead | undefined;
    try {
      read = await deps.read(threadId, link);
    } catch (error) {
      deps.warn("reading a watched pull request failed", {
        threadId,
        key: link.key,
        error: String(error),
      });
      const failures = watch.failures + 1;
      if (failures < PULL_REQUEST_WATCH_FAILURE_LIMIT) {
        await changeWatch(threadId, link, { ...watch, failures });
        return false;
      }
      if ((await changeWatch(threadId, link, undefined)) === undefined) return false;
      await enqueue(threadId, unreadableMessage(link.number, link.url));
      return true;
    }
    if (read === undefined) return false;
    // Merged: nothing left to do, so the watch ends without a word.
    if (read.state === "merged") {
      await changeWatch(threadId, link, undefined);
      return false;
    }
    if (read.state === "closed") {
      if ((await changeWatch(threadId, link, undefined)) === undefined) return false;
      await enqueue(threadId, closedMessage(link.number, link.url));
      return true;
    }
    const report = evaluateWatch(watch, read);
    const message =
      report.changes.length === 0
        ? undefined
        : watchMessage({
            number: link.number,
            url: link.url,
            baseBranch: read.baseBranch,
            headSha: read.headSha,
            report,
          });
    // The news is kept before the watch moves past it, so a failure loses nothing; a watch
    // stopped during the read tells nothing.
    if (message !== undefined) {
      const stored = (await deps.links.list(threadId)).find((item) => item.key === link.key);
      if (stored?.watch?.startedAt !== watch.startedAt) return false;
      await enqueue(threadId, message);
    }
    if (report.exhausted) await changeWatch(threadId, link, undefined);
    else if (JSON.stringify(report.next) !== JSON.stringify(watch)) {
      await changeWatch(threadId, link, report.next);
    }
    return message !== undefined;
  };

  return {
    async watch(threadId, link) {
      const thread = await deps.thread(threadId);
      if (thread?.archived === true) {
        throw new SourceControlError(
          "ACTION_UNAVAILABLE",
          `Thread ${threadId} is archived and cannot watch pull requests`,
        );
      }
      if (link.snapshot?.state === "merged") {
        throw new SourceControlError(
          "ACTION_UNAVAILABLE",
          "The pull request is merged, so there is nothing to watch.",
        );
      }
      if (link.watch !== undefined) return { watching: true, wasWatching: true };
      await deps.links.modify(threadId, link.key, (current) =>
        current.watch === undefined ? { ...current, watch: startWatch(now()) } : undefined,
      );
      return { watching: true, wasWatching: false };
    },
    async unwatch(threadId, link) {
      const stopped = await deps.links.modify(threadId, link.key, (current) => {
        if (current.watch === undefined) return undefined;
        const { watch: _watch, ...rest } = current;
        return rest;
      });
      return { watching: false, wasWatching: stopped !== undefined };
    },
    sweep(threadId) {
      const run = sweeping.then(async () => {
        const ids = threadId === undefined ? await deps.links.threads() : [threadId];
        let checked = 0;
        let woken = 0;
        for (const id of ids) {
          let news = false;
          for (const link of await deps.links.list(id)) {
            if (link.watch === undefined) continue;
            checked += 1;
            // One pull request that cannot be read or told about never stops the others.
            try {
              if (await check(id, link)) news = true;
            } catch (error) {
              deps.warn("watching a pull request failed", {
                threadId: id,
                key: link.key,
                error: String(error),
              });
            }
          }
          if (news) {
            woken += 1;
            await flush(id).catch((error: unknown) =>
              deps.warn("waking a thread failed", { threadId: id, error: String(error) }),
            );
          }
        }
        // News kept from before (a restart, a missed turn end) goes out too.
        for (const entry of await deps.kv.list(NAMESPACE, { prefix: "wake/" })) {
          const id = entry.key.slice("wake/".length);
          if (threadId !== undefined && id !== threadId) continue;
          await flush(id).catch((error: unknown) =>
            deps.warn("waking a thread failed", { threadId: id, error: String(error) }),
          );
        }
        return { checked, woken };
      });
      sweeping = run.catch(() => undefined);
      return run;
    },
    idle: (threadId) => flush(threadId),
  };
}
