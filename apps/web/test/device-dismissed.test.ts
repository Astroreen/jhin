// T3's dismissed devices (preview.md D1427): a device surface the user closed stays away from an
// agent, per thread and on this device, until the user opens it again; the latest 200 threads.
import { describe, expect, it } from "vite-plus/test";

import {
  DISMISSED_KEY,
  MAX_DISMISSED_PLACES,
  createDismissedDevices,
} from "../src/plugins/devices/dismissed.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("dismissed devices", () => {
  it("keeps a closed device away for its thread, across a reload, until opened again", () => {
    const storage = memoryStorage();
    const dismissed = createDismissedDevices(storage);
    dismissed.dismiss("n|t1", ["host:pixel"]);
    expect(dismissed.has("n|t1", "host:pixel")).toBe(true);
    expect(dismissed.has("n|t2", "host:pixel")).toBe(false);

    const reloaded = createDismissedDevices(storage);
    expect(reloaded.has("n|t1", "host:pixel")).toBe(true);
    reloaded.forget("n|t1", "host:pixel");
    expect(reloaded.has("n|t1", "host:pixel")).toBe(false);
    // A thread with nothing dismissed is not kept.
    expect(JSON.parse(storage.items.get(DISMISSED_KEY)!)).toEqual({});
  });

  it("keeps the threads closed in last, the oldest going first", () => {
    const storage = memoryStorage();
    const dismissed = createDismissedDevices(storage);
    for (let index = 0; index < MAX_DISMISSED_PLACES; index += 1) {
      dismissed.dismiss(`n|t${index}`, ["host:pixel"]);
    }
    // The first thread closes another device: it is the latest now, and t1 the oldest.
    dismissed.dismiss("n|t0", ["host:iphone"]);
    dismissed.dismiss(`n|t${MAX_DISMISSED_PLACES}`, ["host:pixel"]);
    const kept = Object.keys(JSON.parse(storage.items.get(DISMISSED_KEY)!) as object);
    expect(kept).toHaveLength(MAX_DISMISSED_PLACES);
    expect(kept).not.toContain("n|t1");
    expect(kept.slice(-2)).toEqual(["n|t0", `n|t${MAX_DISMISSED_PLACES}`]);
    expect(dismissed.has("n|t0", "host:pixel")).toBe(true);
    expect(dismissed.has("n|t1", "host:pixel")).toBe(false);
  });

  it("reads past what it cannot read, and works without storage", () => {
    const broken = createDismissedDevices(memoryStorage({ [DISMISSED_KEY]: "{not json" }));
    expect(broken.has("n|t1", "host:pixel")).toBe(false);
    const odd = createDismissedDevices(
      memoryStorage({ [DISMISSED_KEY]: JSON.stringify({ "n|t1": ["a", 3], "n|t2": "b" }) }),
    );
    expect(odd.has("n|t1", "a")).toBe(true);
    expect(odd.has("n|t2", "b")).toBe(false);
    const none = createDismissedDevices(undefined);
    none.dismiss("n|t1", ["a"]);
    expect(none.has("n|t1", "a")).toBe(true);
  });
});
