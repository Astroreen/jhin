// T3's FileSaveCoordinator (t3-parity.md D1438): one write at a time, the newest winning, what is
// left written when the file closes. Its debounce is 0 here, and each write waits for the test.
import { describe, expect, it } from "vite-plus/test";

import { createSaveCoordinator } from "../src/plugins/chat/file-editor.tsx";

/** Resolves when the next call of `signal` happens. */
function signal() {
  let fire: () => void = () => undefined;
  return {
    next: () =>
      new Promise<void>((resolve) => {
        fire = resolve;
      }),
    fire: () => fire(),
  };
}

function harness() {
  const writes: { contents: string; done(): void; fail(): void }[] = [];
  const wrote = signal();
  const saved = signal();
  const failed = signal();
  const coordinator = createSaveCoordinator({
    debounceMs: 0,
    persist: (contents) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ contents, done: resolve, fail: () => reject(new Error("disk full")) });
        wrote.fire();
      }),
    onPendingChange: (pending) => {
      if (!pending) saved.fire();
    },
    onError: () => failed.fire(),
  });
  return { coordinator, writes, wrote, saved, failed };
}

describe("saving a file as it changes", () => {
  it("writes the newest contents, one write at a time", async () => {
    const { coordinator, writes, wrote, saved } = harness();
    let written = wrote.next();
    coordinator.change("a");
    await written;
    // Changes while the first write runs: only the newest is written next.
    coordinator.change("ab");
    coordinator.change("abc");
    written = wrote.next();
    writes[0]!.done();
    await written;
    expect(writes.map((write) => write.contents)).toEqual(["a", "abc"]);
    const done = saved.next();
    writes[1]!.done();
    await done;
  });

  it("says a write failed, and writes again when it closes", async () => {
    const { coordinator, writes, wrote, failed } = harness();
    let written = wrote.next();
    coordinator.change("x");
    await written;
    const error = failed.next();
    writes[0]!.fail();
    await error;
    written = wrote.next();
    coordinator.dispose();
    await written;
    expect(writes.map((write) => write.contents)).toEqual(["x", "x"]);
  });

  it("after a failed write, the next change writes again", async () => {
    const { coordinator, writes, wrote, saved, failed } = harness();
    let written = wrote.next();
    coordinator.change("x");
    await written;
    const error = failed.next();
    writes[0]!.fail();
    await error;
    // Nothing is retried by itself (T3's coordinator): the file stays pending till it changes.
    expect(writes).toHaveLength(1);
    written = wrote.next();
    coordinator.change("xy");
    await written;
    const done = saved.next();
    writes[1]!.done();
    await done;
    expect(writes.map((write) => write.contents)).toEqual(["x", "xy"]);
  });

  it("says so when the write on close fails, for the panel's toast", async () => {
    const { coordinator, writes, wrote, failed } = harness();
    let written = wrote.next();
    coordinator.change("x");
    await written;
    written = wrote.next();
    coordinator.change("xz");
    coordinator.dispose();
    writes[0]!.done();
    await written;
    const error = failed.next();
    writes[1]!.fail();
    await error;
    expect(writes.map((write) => write.contents)).toEqual(["x", "xz"]);
    // Closed, it takes no more changes.
    coordinator.change("ignored");
    expect(writes).toHaveLength(2);
  });
});
