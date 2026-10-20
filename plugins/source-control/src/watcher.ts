// The sweep follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/orchestration-v2/PullRequestWatchReactor.ts (reading each watched pull
// request, stopping on merge, close and failed reads) and Orchestrator.ts (a wake queued
// after the thread's running turn).
import { PULL_REQUEST_WATCH_FAILURE_LIMIT, type ThreadPullRequest } from "@jhin/source-control-api";
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

  const pending = async (threadId: string): Promise<string[]> => {
    const value = await deps.kv.get(NAMESPACE, `wake/${threadId}`);
    return Array.isArray(value) ? (value as string[]) : [];
  };

  /** Sends what waits for the thread, unless a turn runs: then it waits for that turn's end. */
  const flush = async (threadId: string) => {
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
      await deps.kv.delete(NAMESPACE, `wake/${threadId}`);
    } catch (error) {
      // A turn started meanwhile: the wake waits for it.
      if ((error as { code?: unknown }).code !== "TURN_IN_PROGRESS") throw error;
    }
  };

  /** Wakes the thread with `text`, now or once its running turn ends. */
  const wake = async (threadId: string, text: string) => {
    await deps.kv.set(NAMESPACE, `wake/${threadId}`, [
      ...(await pending(threadId)),
      text,
    ] as unknown as Json);
    await flush(threadId);
  };

  const stop = (threadId: string, link: ThreadPullRequest) => {
    const { watch: _watch, ...rest } = link;
    return deps.links.update(threadId, rest);
  };

  const check = async (threadId: string, link: ThreadPullRequest): Promise<boolean> => {
    const watch = link.watch!;
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
        await deps.links.update(threadId, { ...link, watch: { ...watch, failures } });
        return false;
      }
      await stop(threadId, link);
      await wake(threadId, unreadableMessage(link.number, link.url));
      return true;
    }
    if (read === undefined) return false;
    // Merged: nothing left to do, so the watch ends without a word.
    if (read.state === "merged") {
      await stop(threadId, link);
      return false;
    }
    if (read.state === "closed") {
      await stop(threadId, link);
      await wake(threadId, closedMessage(link.number, link.url));
      return true;
    }
    const report = evaluateWatch(watch, read);
    if (report.exhausted) await stop(threadId, link);
    else if (JSON.stringify(report.next) !== JSON.stringify(watch)) {
      await deps.links.update(threadId, { ...link, watch: report.next });
    }
    if (report.changes.length === 0) return false;
    await wake(
      threadId,
      watchMessage({
        number: link.number,
        url: link.url,
        baseBranch: read.baseBranch,
        headSha: read.headSha,
        report,
      }),
    );
    return true;
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
      await deps.links.update(threadId, { ...link, watch: startWatch(new Date().toISOString()) });
      return { watching: true, wasWatching: false };
    },
    async unwatch(threadId, link) {
      if (link.watch === undefined) return { watching: false, wasWatching: false };
      await stop(threadId, link);
      return { watching: false, wasWatching: true };
    },
    sweep(threadId) {
      const run = sweeping.then(async () => {
        const ids = threadId === undefined ? await deps.links.threads() : [threadId];
        let checked = 0;
        let woken = 0;
        for (const id of ids) {
          for (const link of await deps.links.list(id)) {
            if (link.watch === undefined) continue;
            checked += 1;
            if (await check(id, link)) woken += 1;
          }
        }
        return { checked, woken };
      });
      sweeping = run.catch(() => undefined);
      return run;
    },
    idle: (threadId) => flush(threadId),
  };
}
