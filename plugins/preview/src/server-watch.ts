// The watch follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/preview/PortScanner.ts
// (`retain`, `subscribe` and `pollTick`: one scan a tick while somebody watches, a push to each
// subscriber only when its list changed). docs/plans/preview.md, D1692.
import {
  PREVIEW_SERVERS_STREAM_PREFIX,
  PreviewEvents,
  previewServersStreamUrls,
} from "@jhin/preview-api";
import type { StreamSource } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";

import type { DiscoveredLocalServer } from "./local-servers.ts";

/** T3's `POLL_INTERVAL`. */
export const SERVER_WATCH_INTERVAL_MS = 3_000;
/** How many configured-URL sets may be watched at once: each costs a scan per tick. */
const SERVER_WATCH_MAX_STREAMS = 20;

interface Watched {
  readonly urls: readonly string[];
  readonly listeners: Set<(event: StoredEvent) => void>;
  /** The latest list, the stream's only event. */
  latest?: StoredEvent;
  /** The servers of `latest`, to tell a change. */
  key?: string;
}

/**
 * The `preview-servers/…` streams (D1692): while one has a subscriber, the node scans every
 * `SERVER_WATCH_INTERVAL_MS` (`every` runs the tick; tests run it by hand) and appends the
 * list to a stream when it changed. A stream keeps its latest list only, so a subscriber
 * from 0 gets it at once.
 */
export function createServerWatch(options: {
  /** The servers for these configured URLs; shared with `preview.servers.list`. */
  list(
    configuredUrls: readonly string[],
  ): Promise<{ servers: DiscoveredLocalServer[]; scannedAt: string }>;
  /** Runs `tick` on the interval until disposed; it settles when its scan is done. */
  every(tick: () => Promise<void>): Disposable;
  /** The clock sequences start from; `Date.now` by default. */
  now?(): number;
  warn(message: string, fields: Record<string, unknown>): void;
}): StreamSource &
  Disposable & {
    /** Settles once no scan runs (the one running, and the one it asked for). */
    settled(): Promise<void>;
  } {
  const watched = new Map<string, Watched>();
  const now = options.now ?? Date.now;
  /**
   * The last sequence handed out, by any stream. A client resumes a stream after the last
   * sequence it saw, also after the node forgot the stream or restarted: sequences only
   * grow, from the clock, so its next list is never taken for one it already had.
   */
  let sequence = 0;
  let ticker: Disposable | undefined;
  let scanning: Promise<void> | undefined;
  /** A watcher came during a scan that did not cover it: scan again once it ends. */
  let again = false;

  const entry = (stream: string): Watched => {
    const known = watched.get(stream);
    if (known !== undefined) return known;
    const urls = previewServersStreamUrls(stream);
    if (urls === undefined) throw new Error(`Not a local servers stream: ${stream}`);
    if (watched.size >= SERVER_WATCH_MAX_STREAMS) {
      throw new Error(
        `At most ${SERVER_WATCH_MAX_STREAMS} sets of local servers are watched at once`,
      );
    }
    const created: Watched = { urls, listeners: new Set() };
    watched.set(stream, created);
    return created;
  };

  const publish = (
    stream: string,
    watch: Watched,
    list: Awaited<ReturnType<typeof options.list>>,
  ) => {
    const key = JSON.stringify(list.servers);
    if (key === watch.key) return;
    watch.key = key;
    const event: StoredEvent = {
      stream,
      sequence: (sequence = Math.max(sequence + 1, now())),
      type: PreviewEvents.servers,
      payload: list as unknown as StoredEvent["payload"],
      at: list.scannedAt,
    };
    watch.latest = event;
    for (const listener of Array.from(watch.listeners)) listener(event);
  };

  /**
   * One scan per set of configured URLs being watched. An interval's tick during a scan is
   * skipped, as T3's; a new watcher's runs once the scan ends (`fresh`).
   */
  const tick = (fresh = false): Promise<void> => {
    if (scanning !== undefined) {
      if (fresh) again = true;
      return scanning;
    }
    const run = async () => {
      const bySet = new Map<string, string[]>();
      for (const [stream, watch] of watched) {
        if (watch.listeners.size === 0) continue;
        const set = JSON.stringify(watch.urls);
        bySet.set(set, [...(bySet.get(set) ?? []), stream]);
      }
      for (const [set, streams] of bySet) {
        try {
          const list = await options.list(JSON.parse(set) as string[]);
          for (const stream of streams) {
            const watch = watched.get(stream);
            if (watch !== undefined && watch.listeners.size > 0) publish(stream, watch, list);
          }
        } catch (error) {
          // A failed scan keeps the last list; the next tick tries again.
          options.warn("local servers not scanned", { error: String(error) });
        }
      }
    };
    scanning = run().finally(() => {
      scanning = undefined;
      if (again) {
        again = false;
        void tick();
      }
    });
    return scanning;
  };

  const release = () => {
    for (const [stream, watch] of watched) {
      // A stream nobody watches forgets its list: the next watcher gets a fresh scan.
      if (watch.listeners.size === 0) watched.delete(stream);
    }
    if (watched.size === 0) {
      ticker?.dispose();
      ticker = undefined;
    }
  };

  return {
    async head(stream) {
      return watched.get(stream)?.latest?.sequence ?? 0;
    },
    async read(stream, readOptions) {
      const latest = watched.get(stream)?.latest;
      return latest !== undefined && latest.sequence > (readOptions?.after ?? 0) ? [latest] : [];
    },
    subscribe(stream, listener) {
      if (!stream.startsWith(PREVIEW_SERVERS_STREAM_PREFIX)) {
        throw new Error(`Not a local servers stream: ${stream}`);
      }
      const watch = entry(stream);
      watch.listeners.add(listener);
      // The first watcher starts the interval, and every new one gets a scan at once (T3's retain).
      ticker ??= options.every(() => tick());
      void tick(true);
      return toDisposable(() => {
        watch.listeners.delete(listener);
        release();
      });
    },
    async settled() {
      for (let current = scanning; current !== undefined; current = scanning) await current;
    },
    dispose() {
      ticker?.dispose();
      ticker = undefined;
      watched.clear();
    },
  };
}
