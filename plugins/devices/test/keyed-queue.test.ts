import { describe, expect, it } from "vite-plus/test";

import { createKeyedQueue } from "../src/keyed-queue.ts";

/** A promise the test settles. */
function gate() {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

describe("one action at a time per device (D1332)", () => {
  it("runs a device's work in order, and another device's beside it", async () => {
    const queue = createKeyedQueue();
    const order: string[] = [];
    const action = gate();
    const first = queue.run("local\u0000a", async () => {
      order.push("action starts");
      await action.promise;
      order.push("action ends");
    });
    const read = queue.run("local\u0000a", async () => {
      order.push("read");
    });
    // Another device does not wait for this one.
    await queue.run("local\u0000b", async () => {
      order.push("other device");
    });
    expect(order).toEqual(["action starts", "other device"]);
    action.open();
    await Promise.all([first, read]);
    expect(order).toEqual(["action starts", "other device", "action ends", "read"]);
  });

  it("does not hold the next back behind a failed one", async () => {
    const queue = createKeyedQueue();
    const action = gate();
    const failed = queue.run("local\u0000a", () => action.promise);
    const next = queue.run("local\u0000a", async () => "read");
    action.fail(new Error("adb went"));
    await expect(failed).rejects.toThrow("adb went");
    await expect(next).resolves.toBe("read");
  });
});
