// T3's FileSaveCoordinator (t3-parity.md D1438): one write at a time, the newest winning, what is
// left written when the file closes. Its debounce is 0 here, and each write waits for the test.
import { describe, expect, it } from "vite-plus/test";

import { createSaveCoordinator } from "../src/plugins/chat/file-editor.tsx";

function harness() {
  const writes: { contents: string; done(): void; fail(): void }[] = [];
  let wrote: () => void = () => undefined;
  const nextWrite = () =>
    new Promise<void>((resolve) => {
      wrote = resolve;
    });
  const pending: boolean[] = [];
  const errors: unknown[] = [];
  const coordinator = createSaveCoordinator({
    debounceMs: 0,
    persist: (contents) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ contents, done: resolve, fail: () => reject(new Error("disk full")) });
        wrote();
      }),
    onPendingChange: (value) => pending.push(value),
    onError: (error) => errors.push(error),
  });
  return { coordinator, writes, nextWrite, pending, errors };
}

describe("saving a file as it changes", () => {
  it("writes the newest contents, one write at a time", async () => {
    const { coordinator, writes, nextWrite, pending } = harness();
    let written = nextWrite();
    coordinator.change("a");
    await written;
    // Changes while the first write runs: only the newest is written next.
    coordinator.change("ab");
    coordinator.change("abc");
    written = nextWrite();
    writes[0]!.done();
    await written;
    expect(writes.map((write) => write.contents)).toEqual(["a", "abc"]);
    expect(pending.at(-1)).toBe(true);
    writes[1]!.done();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.at(-1)).toBe(false);
  });

  it("says a write failed, and writes again on the next change or when it closes", async () => {
    const { coordinator, writes, nextWrite, errors } = harness();
    let written = nextWrite();
    coordinator.change("x");
    await written;
    writes[0]!.fail();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    written = nextWrite();
    coordinator.dispose();
    await written;
    expect(writes.map((write) => write.contents)).toEqual(["x", "x"]);
  });
});
