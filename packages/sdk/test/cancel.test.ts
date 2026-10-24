import { describe, expect, it } from "vite-plus/test";

import { createCancelSignal } from "../src/index.ts";

describe("createCancelSignal (D1501)", () => {
  it("aborts once, tells every listener, and never a late or removed one", () => {
    const { signal, cancel } = createCancelSignal();
    const heard: string[] = [];
    const removed = () => heard.push("removed");
    signal.addEventListener("abort", () => heard.push("a"));
    signal.addEventListener("abort", removed);
    signal.removeEventListener("abort", removed);
    expect(signal.aborted).toBe(false);

    cancel();
    cancel();
    signal.addEventListener("abort", () => heard.push("late"));

    expect(signal.aborted).toBe(true);
    expect(heard).toEqual(["a"]);
  });

  it("tells the listeners after one that throws, then throws its error", () => {
    const { signal, cancel } = createCancelSignal();
    const heard: string[] = [];
    signal.addEventListener("abort", () => {
      throw new Error("first");
    });
    signal.addEventListener("abort", () => heard.push("second"));

    expect(() => cancel()).toThrow("first");
    expect(heard).toEqual(["second"]);
    expect(signal.aborted).toBe(true);
  });
});
