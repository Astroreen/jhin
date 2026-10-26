import { describe, expect, it } from "vite-plus/test";

import { createIdlePrefetch } from "../src/lib/idle-prefetch.ts";

/** A window whose load event and idle callbacks the test runs by hand. */
function fakeWindow(options: { readyState?: DocumentReadyState; saveData?: boolean } = {}) {
  const idle: (() => void)[] = [];
  const timeouts: (() => void)[] = [];
  let onLoad: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  return {
    idle,
    /** Resolves when the queue asks for its next idle callback. */
    nextIdle: () => new Promise<void>((resolve) => (scheduled = resolve)),
    timeouts,
    load: () => onLoad?.(),
    runIdle: () => idle.shift()?.(),
    win: {
      document: { readyState: options.readyState ?? "loading" },
      navigator: { connection: { saveData: options.saveData ?? false } },
      addEventListener: (_type: "load", listener: () => void) => {
        onLoad = listener;
      },
      removeEventListener: () => {
        onLoad = undefined;
      },
      requestIdleCallback: (callback: () => void) => {
        const handle = idle.push(callback);
        scheduled?.();
        return handle;
      },
      cancelIdleCallback: (handle: number) => {
        idle.splice(handle - 1, 1);
      },
      setTimeout: (callback: () => void) => timeouts.push(callback),
      clearTimeout: () => undefined,
    },
  };
}

/** A prefetch the test settles, recording when it started. */
function chunk(started: string[], name: string) {
  let settle: (() => void) | undefined;
  return {
    prefetch: () => {
      started.push(name);
      return new Promise<void>((resolve) => (settle = resolve));
    },
    settle: () => settle?.(),
  };
}

describe("idle prefetch (D1596, D1615)", () => {
  it("waits for the load event, then fetches one chunk per idle callback", async () => {
    const fake = fakeWindow();
    const prefetch = createIdlePrefetch(fake.win);
    const started: string[] = [];
    const settings = chunk(started, "settings");
    const browser = chunk(started, "browser");
    prefetch.add(settings.prefetch);
    prefetch.add(browser.prefetch);
    expect(fake.idle).toHaveLength(0);
    fake.load();
    expect(fake.idle).toHaveLength(1);
    fake.runIdle();
    expect(started).toEqual(["settings"]);
    // The next chunk waits for the one being fetched.
    expect(fake.idle).toHaveLength(0);
    const asked = fake.nextIdle();
    settings.settle();
    await asked;
    fake.runIdle();
    expect(started).toEqual(["settings", "browser"]);
  });

  it("starts at once on a page that has already loaded", () => {
    const fake = fakeWindow({ readyState: "complete" });
    const prefetch = createIdlePrefetch(fake.win);
    const started: string[] = [];
    prefetch.add(chunk(started, "settings").prefetch);
    fake.runIdle();
    expect(started).toEqual(["settings"]);
  });

  it("goes on after a chunk that failed to fetch", async () => {
    const fake = fakeWindow({ readyState: "complete" });
    const prefetch = createIdlePrefetch(fake.win);
    const started: string[] = [];
    prefetch.add(() => {
      started.push("broken");
      return Promise.reject(new Error("offline"));
    });
    prefetch.add(chunk(started, "browser").prefetch);
    const asked = fake.nextIdle();
    fake.runIdle();
    await asked;
    fake.runIdle();
    expect(started).toEqual(["broken", "browser"]);
  });

  it("goes on after a prefetch that throws before it returns a promise", async () => {
    const fake = fakeWindow({ readyState: "complete" });
    const prefetch = createIdlePrefetch(fake.win);
    const started: string[] = [];
    prefetch.add(() => {
      started.push("throws");
      throw new Error("no chunk");
    });
    prefetch.add(chunk(started, "browser").prefetch);
    const asked = fake.nextIdle();
    fake.runIdle();
    await asked;
    fake.runIdle();
    expect(started).toEqual(["throws", "browser"]);
  });

  it("fetches nothing when the browser asks to save data", () => {
    const fake = fakeWindow({ readyState: "complete", saveData: true });
    const prefetch = createIdlePrefetch(fake.win);
    const started: string[] = [];
    prefetch.add(chunk(started, "settings").prefetch);
    expect(fake.idle).toHaveLength(0);
    expect(started).toEqual([]);
  });

  it("takes a disposed chunk off the queue", () => {
    const fake = fakeWindow();
    const prefetch = createIdlePrefetch(fake.win);
    const started: string[] = [];
    prefetch.add(chunk(started, "settings").prefetch).dispose();
    prefetch.add(chunk(started, "browser").prefetch);
    fake.load();
    fake.runIdle();
    expect(started).toEqual(["browser"]);
  });

  it("falls back to the next task where there is no idle callback", () => {
    const fake = fakeWindow({ readyState: "complete" });
    const { requestIdleCallback: _idle, cancelIdleCallback: _cancel, ...win } = fake.win;
    const prefetch = createIdlePrefetch(win);
    const started: string[] = [];
    prefetch.add(chunk(started, "settings").prefetch);
    expect(fake.timeouts).toHaveLength(1);
    fake.timeouts[0]!();
    expect(started).toEqual(["settings"]);
  });
});
