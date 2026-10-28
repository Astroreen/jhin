import { PreviewEvents, previewServersStream, previewServersStreamUrls } from "@jhin/preview-api";
import { toDisposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import type { DiscoveredLocalServer } from "../src/local-servers.ts";
import { createServerWatch } from "../src/server-watch.ts";

const server = (port: number): DiscoveredLocalServer => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}`,
  processName: "node",
  pid: 100 + port,
  terminal: null,
});

/** A watch whose scans answer what the test says, and whose interval the test runs. */
function harness() {
  const scans: { urls: readonly string[]; answer(servers: DiscoveredLocalServer[]): void }[] = [];
  const waiting: (() => void)[] = [];
  let tick: (() => Promise<void>) | undefined;
  let stopped = 0;
  const watch = createServerWatch({
    list: (urls) =>
      new Promise((resolve) => {
        scans.push({
          urls,
          answer: (servers) => resolve({ servers, scannedAt: "2026-10-28T12:00:00.000Z" }),
        });
        for (const wake of waiting.splice(0)) wake();
      }),
    every: (run) => {
      tick = run;
      return toDisposable(() => {
        tick = undefined;
        stopped += 1;
      });
    },
    warn: () => undefined,
    // A clock that stands still: sequences then count up from it.
    now: () => 1000,
  });
  return {
    watch,
    scans,
    /** The next scan the watch starts. */
    nextScan: async (index: number) => {
      while (scans.length <= index) await new Promise<void>((wake) => waiting.push(wake));
      return scans[index]!;
    },
    /** The interval's tick: it settles once its scan (or the one running) is done. */
    tick: () => tick?.() ?? Promise.resolve(),
    ticking: () => tick !== undefined,
    stopped: () => stopped,
  };
}

/** The events a subscriber gets, and a wait for the next one. */
function events() {
  const seen: StoredEvent[] = [];
  const waiting: (() => void)[] = [];
  return {
    seen,
    listener: (event: StoredEvent) => {
      seen.push(event);
      for (const wake of waiting.splice(0)) wake();
    },
    count: async (count: number) => {
      while (seen.length < count) await new Promise<void>((wake) => waiting.push(wake));
    },
  };
}

describe("the pushed local servers (preview.md D1692)", () => {
  it("names a stream by its configured URLs, in any order", () => {
    const stream = previewServersStream(["http://localhost:5173/", "http://localhost:3000/"]);
    expect(stream).toBe(previewServersStream(["http://localhost:3000/", "http://localhost:5173/"]));
    expect(previewServersStreamUrls(stream)).toEqual([
      "http://localhost:3000/",
      "http://localhost:5173/",
    ]);
    expect(previewServersStreamUrls(previewServersStream())).toEqual([]);
    expect(previewServersStreamUrls("preview-servers/%7Bnot")).toBeUndefined();
    expect(previewServersStreamUrls("preview/thread")).toBeUndefined();
  });

  it("scans at once for a watcher, pushes a change only, and stops with the last watcher", async () => {
    const { watch, nextScan, tick, ticking, stopped } = harness();
    const stream = previewServersStream();
    const first = events();
    const subscription = watch.subscribe(stream, first.listener);
    expect(ticking()).toBe(true);
    (await nextScan(0)).answer([server(5173)]);
    await first.count(1);
    expect(first.seen[0]).toMatchObject({
      stream,
      sequence: 1000,
      type: PreviewEvents.servers,
      payload: { servers: [server(5173)] },
    });
    // A late subscriber reads the latest list from 0.
    expect(await watch.head(stream)).toBe(1000);
    expect(await watch.read(stream, { after: 0 })).toEqual([first.seen[0]]);

    // The scan that pushed it ends; then the same list again is no event, and a new one is.
    await watch.settled();
    const same = tick();
    (await nextScan(1)).answer([server(5173)]);
    await same;
    expect(first.seen).toHaveLength(1);
    const changed = tick();
    (await nextScan(2)).answer([server(5173), server(3000)]);
    await changed;
    expect(first.seen.map((event) => event.sequence)).toEqual([1000, 1001]);

    subscription.dispose();
    expect(ticking()).toBe(false);
    expect(stopped()).toBe(1);
    expect(await watch.head(stream)).toBe(0);

    // A client that comes back (a reconnect) resumes after the last sequence it saw: the
    // forgotten stream's next list still comes after it.
    const back = events();
    watch.subscribe(stream, back.listener);
    (await nextScan(3)).answer([server(5173)]);
    await back.count(1);
    expect(back.seen[0]!.sequence).toBeGreaterThan(1001);
  });

  it("scans each set of configured URLs, and refuses a name that is not a list", async () => {
    const { watch, nextScan } = harness();
    const plain = events();
    const project = events();
    watch.subscribe(previewServersStream(), plain.listener);
    // A second watcher during the first scan gets a scan of its own once that one ends.
    watch.subscribe(previewServersStream(["http://localhost:3000/"]), project.listener);
    (await nextScan(0)).answer([]);
    // The rescan covers both sets, one after the other.
    const again = await nextScan(1);
    expect(again.urls).toEqual([]);
    again.answer([]);
    const second = await nextScan(2);
    expect(second.urls).toEqual(["http://localhost:3000/"]);
    second.answer([server(3000)]);
    await plain.count(1);
    await project.count(1);
    expect(project.seen[0]?.payload).toMatchObject({ servers: [server(3000)] });
    expect(() => watch.subscribe("preview-servers/nope", () => undefined)).toThrow(
      /Not a local servers stream/,
    );
    // Each set costs a scan a tick: at most 20 are watched.
    for (let port = 1; port <= 18; port += 1) {
      watch.subscribe(previewServersStream([`http://localhost:${port}/`]), () => undefined);
    }
    expect(() =>
      watch.subscribe(previewServersStream(["http://localhost:19/"]), () => undefined),
    ).toThrow(/At most 20/);
  });
});
