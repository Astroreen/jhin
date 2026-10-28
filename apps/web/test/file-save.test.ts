// T3's FileSaveCoordinator (t3-parity.md D1438, D1645, D1646): one write at a time, the newest
// winning, what is left written when the file closes, nothing written while a connection is
// read-only. Its debounce is 0 here, and each write waits for the test.
import { describe, expect, it } from "vite-plus/test";

import {
  createFileEdits,
  createSaveCoordinator,
  isPermissionDenied,
} from "../src/plugins/chat/file-edits.ts";

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

describe("a write refused, and the panel's edits (D1645, D1646)", () => {
  it("keeps a change pending while nothing may be written, and writes it once it may", async () => {
    let writable = false;
    const writes: string[] = [];
    const pending: boolean[] = [];
    const asked = signal();
    const wrote = signal();
    const saved = signal();
    const coordinator = createSaveCoordinator({
      debounceMs: 0,
      canPersist: () => {
        asked.fire();
        return writable;
      },
      persist: async (contents) => {
        writes.push(contents);
        wrote.fire();
      },
      onPendingChange: (value) => {
        pending.push(value);
        if (!value) saved.fire();
      },
      onError: () => undefined,
    });
    const refused = asked.next();
    coordinator.change("kept");
    await refused;
    // Nothing goes while it may not, and the change stays pending.
    expect(writes).toEqual([]);
    expect(pending).toEqual([true]);
    writable = true;
    const written = wrote.next();
    const done = saved.next();
    // T3 queues the kept draft again when write access returns.
    coordinator.change("kept");
    await written;
    await done;
    expect(writes).toEqual(["kept"]);
    expect(pending).toEqual([true, true, false]);
  });

  it("stays pending when the write's contents are no longer the newest", async () => {
    const pending: boolean[] = [];
    const confirmed = signal();
    const coordinator = createSaveCoordinator({
      debounceMs: 0,
      persist: async () => undefined,
      onPendingChange: (value) => pending.push(value),
      onConfirmed: () => {
        confirmed.fire();
        return false;
      },
      onError: () => undefined,
    });
    const written = confirmed.next();
    coordinator.change("a");
    await written;
    // No "saved" for contents another edit replaced.
    expect(pending).toEqual([true]);
  });

  it("knows a write refused for want of permission", () => {
    expect(isPermissionDenied({ code: "PERMISSION_DENIED" })).toBe(true);
    expect(isPermissionDenied(new Error("disk full"))).toBe(false);
    expect(isPermissionDenied(undefined)).toBe(false);
  });

  it("turns a node read-only until the connection to it changes", () => {
    const listeners = new Set<() => void>();
    const clientA = {};
    const clientB = {};
    let connection: { client: object; state: "open" | "connecting" | "closed" } | undefined = {
      client: clientA,
      state: "open",
    };
    const connections = {
      get: () => connection,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    } as unknown as Parameters<typeof createFileEdits>[0];
    const changed = () => {
      for (const listener of listeners) listener();
    };
    const edits = createFileEdits(connections);
    const target = { node: "ws://a/rpc" };
    let notified = 0;
    edits.subscribe(() => (notified += 1));
    edits.refuse(target);
    expect(edits.readOnly(target)).toBe(true);
    expect(edits.readOnly({ node: "ws://a/rpc", remote: "b" })).toBe(false);
    expect(notified).toBe(1);
    // Nothing changed on the connection: still read-only.
    changed();
    expect(edits.readOnly(target)).toBe(true);
    // A reconnect: dropped, then open again.
    connection = { client: clientA, state: "connecting" };
    changed();
    expect(edits.readOnly(target)).toBe(true);
    connection = { client: clientA, state: "open" };
    changed();
    expect(edits.readOnly(target)).toBe(false);
    expect(notified).toBe(2);
    // A new token is another client.
    edits.refuse(target);
    connection = { client: clientB, state: "open" };
    changed();
    expect(edits.readOnly(target)).toBe(false);
    edits.dispose();
    expect(listeners.size).toBe(0);
  });

  it("shows a written text until a read after the write, unless it changed since", () => {
    const edits = createFileEdits({
      get: () => undefined,
      subscribe: () => ({ dispose: () => undefined }),
    } as unknown as Parameters<typeof createFileEdits>[0]);
    edits.edit("f", "one");
    expect(edits.draft("f")).toEqual({ contents: "one", confirmed: false });
    // A write of older contents confirms nothing.
    expect(edits.confirm("f", "zero")).toBeUndefined();
    const written = edits.confirm("f", "one")!;
    expect(edits.draft("f")).toEqual({ contents: "one", confirmed: true });
    edits.edit("f", "two");
    edits.settle("f", written);
    expect(edits.draft("f")).toEqual({ contents: "two", confirmed: false });
    edits.settle("f", edits.confirm("f", "two")!);
    expect(edits.draft("f")).toBeUndefined();
    edits.setPending("f", true);
    expect(edits.pending("f")).toBe(true);
    edits.setPending("f", false);
    expect(edits.pending("f")).toBe(false);
  });
});
