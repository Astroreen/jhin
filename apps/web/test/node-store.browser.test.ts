import { describe, expect, it } from "vite-plus/test";

import { LEGACY_STORAGE_KEY, createNodeStore } from "../src/lib/node-store.ts";

describe("saved nodes (security.md D423)", () => {
  it("moves nodes saved in localStorage into IndexedDB once, and removes the old key", async () => {
    const saved = [{ url: "ws://a.example/rpc", token: "t".repeat(43), label: "a" }];
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(saved));
    const store = createNodeStore();

    expect(await store.load()).toEqual(saved);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    // Saved later, read back from IndexedDB alone.
    await store.save([{ url: "ws://b.example/rpc", session: true, label: "b" }]);
    expect(await createNodeStore().load()).toEqual([
      { url: "ws://b.example/rpc", session: true, label: "b" },
    ]);
  });

  it("tells other tabs about a save", async () => {
    const mine = createNodeStore();
    const theirs = createNodeStore();
    const heard = new Promise<void>((resolve) => theirs.onChange(resolve));
    await mine.save([]);
    await heard;
  });

  it("adds legacy nodes to those already saved, and moves an unreadable entry as nothing", async () => {
    const store = createNodeStore();
    await store.save([{ url: "ws://kept.example/rpc", session: true, label: "kept" }]);
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify([{ url: "ws://old.example/rpc", token: "t".repeat(43), label: "old" }]),
    );
    expect(await createNodeStore().load()).toEqual([
      { url: "ws://kept.example/rpc", session: true, label: "kept" },
      { url: "ws://old.example/rpc", token: "t".repeat(43), label: "old" },
    ]);

    await store.save([]);
    localStorage.setItem(LEGACY_STORAGE_KEY, "{ not json");
    expect(await createNodeStore().load()).toEqual([]);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});
