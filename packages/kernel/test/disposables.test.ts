import { DisposableStore, toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

describe("DisposableStore", () => {
  it("forgets a deleted item: disposing the store no longer disposes it", () => {
    const store = new DisposableStore();
    const disposed: string[] = [];
    store.add(toDisposable(() => disposed.push("kept")));
    const gone = store.add(toDisposable(() => disposed.push("gone")));
    store.delete(gone);
    store.delete(gone);
    store.dispose();
    expect(disposed).toEqual(["kept"]);
  });
});
