import type { ThreadWorkTask } from "@jhin/client-api";
import { workHoldsCompletion } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { createThreadWork } from "../src/plugins/thread-work.ts";

describe("client.thread-work (D1131)", () => {
  it("joins the tasks of every source and tells when they change", () => {
    const work = createThreadWork();
    let changes = 0;
    work.subscribe(() => changes++);
    let watched: ThreadWorkTask[] = [];
    let notify = () => {};
    const source = work.register({
      tasks: (target, threadId) => (target.node === "n" && threadId === "t" ? watched : []),
      subscribe: (listener) => {
        notify = listener;
        return { dispose: () => (notify = () => {}) };
      },
    });
    expect(changes).toBe(1);
    expect(work.tasks({ node: "n" }, "t")).toEqual([]);
    watched = [{ taskId: "w", description: "Watching pull request #1", kind: "monitor" }];
    notify();
    expect(changes).toBe(2);
    expect(workHoldsCompletion(work.tasks({ node: "n" }, "t"))).toBe(true);
    // A command does not hold the thread's completion (T3's rule).
    expect(workHoldsCompletion([{ taskId: "c", kind: "command" }])).toBe(false);
    // A source that throws reports nothing, and keeps the others' tasks.
    const broken = work.register({
      tasks: () => {
        throw new Error("broken");
      },
      subscribe: () => ({ dispose: () => undefined }),
    });
    expect(work.tasks({ node: "n" }, "t")).toHaveLength(1);
    expect(changes).toBe(3);
    broken.dispose();
    expect(changes).toBe(4);
    source.dispose();
    expect(changes).toBe(5);
    expect(work.tasks({ node: "n" }, "t")).toEqual([]);
  });

  it("joins several sources, and a disposed one tells nothing more", () => {
    const work = createThreadWork();
    let changes = 0;
    work.subscribe(() => changes++);
    let notifyA = () => {};
    const a = work.register({
      tasks: () => [{ taskId: "a", kind: "monitor" }],
      subscribe: (listener) => {
        notifyA = listener;
        return { dispose: () => (notifyA = () => {}) };
      },
    });
    work.register({
      tasks: () => [{ taskId: "b", kind: "subagent" }],
      subscribe: () => ({ dispose: () => undefined }),
    });
    expect(work.tasks({ node: "n" }, "t").map((task) => task.taskId)).toEqual(["a", "b"]);
    a.dispose();
    const before = changes;
    notifyA();
    expect(changes).toBe(before);
    expect(work.tasks({ node: "n" }, "t").map((task) => task.taskId)).toEqual(["b"]);
  });

  it("takes a source registered twice once", () => {
    const work = createThreadWork();
    let subscribed = 0;
    const source = {
      tasks: () => [{ taskId: "a", kind: "monitor" as const }],
      subscribe: () => {
        subscribed++;
        return { dispose: () => undefined };
      },
    };
    const first = work.register(source);
    work.register(source).dispose();
    expect(subscribed).toBe(1);
    expect(work.tasks({ node: "n" }, "t")).toHaveLength(1);
    first.dispose();
    expect(work.tasks({ node: "n" }, "t")).toEqual([]);
  });

  it("adds no source that cannot be followed, and the registering plugin goes on", () => {
    const warnings: string[] = [];
    const work = createThreadWork((message) => warnings.push(message));
    const registration = work.register({
      tasks: () => [{ taskId: "a", kind: "monitor" as const }],
      subscribe: () => {
        throw new Error("no feed");
      },
    });
    expect(work.tasks({ node: "n" }, "t")).toEqual([]);
    expect(warnings).toEqual(["a thread work source could not be followed"]);
    registration.dispose();
  });

  it("tells every listener of a change, whatever another one throws", () => {
    const warnings: string[] = [];
    const work = createThreadWork((message) => warnings.push(message));
    let heard = 0;
    work.subscribe(() => {
      throw new Error("listener");
    });
    work.subscribe(() => heard++);
    work.register({ tasks: () => [], subscribe: () => ({ dispose: () => undefined }) });
    expect(heard).toBe(1);
    expect(warnings).toEqual(["a thread work listener failed"]);
  });
});
