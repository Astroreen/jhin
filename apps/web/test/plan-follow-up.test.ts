import { ThreadEvents } from "@jhin/agent-api";
import type { Navigation, Route } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { implementPlan } from "../src/plugins/chat/plan-follow-up.ts";

const PLAN = "# Add a cache\n\n1. Read\n";
const target = { node: "n1" };

/** A node answering the calls implementPlan makes, recording them. */
function fakeNode(
  events: { type: string; payload: unknown }[],
  fail: Record<string, { code: string; message: string }> = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  const threads = {
    async call<T>(_target: unknown, method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      const failure = fail[method];
      if (failure !== undefined)
        throw Object.assign(new Error(failure.message), { code: failure.code });
      switch (method) {
        case "threads.events":
          return events.map((event, index) => ({
            stream: "thread/t1",
            sequence: index + 1,
            at: "2026-10-20T12:00:00.000Z",
            ...event,
          })) as T;
        case "threads.get":
          return {
            thread: {
              id: "t1",
              projectId: "p1",
              title: "Add a cache",
              createdAt: "2026-10-20T12:00:00.000Z",
              agentId: "acme.claude",
              model: "opus",
              runtimeMode: "approval-required",
              interactionMode: "plan",
            },
            stream: "thread/t1",
            head: events.length,
          } as T;
        case "threads.create":
          return { id: "t2", projectId: "p1", title: "x", createdAt: "" } as T;
        default:
          return {} as T;
      }
    },
  };
  return { threads, calls };
}

const proposed = [
  {
    type: ThreadEvents.turnStarted,
    payload: { turnId: "u1", agentId: "acme.claude", input: { text: "plan" } },
  },
  { type: ThreadEvents.planProposed, payload: { turnId: "u1", itemId: "p", markdown: PLAN } },
  { type: ThreadEvents.turnCompleted, payload: { turnId: "u1" } },
];

describe("implementPlan (D306)", () => {
  it("sends the plan to the thread in build mode with the thread's agent and model", async () => {
    const { threads, calls } = fakeNode(proposed);
    expect(await implementPlan({ threads }, { target, threadId: "t1", newThread: false })).toEqual({
      threadId: "t1",
    });
    expect(calls.at(-1)).toEqual({
      method: "threads.send",
      params: {
        threadId: "t1",
        text: "PLEASE IMPLEMENT THIS PLAN:\n# Add a cache\n\n1. Read",
        agentId: "acme.claude",
        model: "opus",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
  });

  it("starts a thread in the same project titled after the plan, and opens it", async () => {
    const { threads, calls } = fakeNode(proposed);
    const routes: Route[] = [];
    const navigation = { navigate: (route: Route) => routes.push(route) } as unknown as Navigation;
    expect(
      await implementPlan({ threads, navigation }, { target, threadId: "t1", newThread: true }),
    ).toEqual({ threadId: "t2" });
    expect(calls.find((call) => call.method === "threads.create")?.params).toEqual({
      // Chosen by the client, so asking again makes no second thread (D207).
      threadId: expect.any(String),
      projectId: "p1",
      title: "Implement Add a cache",
      agentId: "acme.claude",
      model: "opus",
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(calls.at(-1)).toMatchObject({ method: "threads.send", params: { threadId: "t2" } });
    expect(routes).toEqual([{ node: "n1", thread: "t2" }]);
  });

  it("says the thread is busy, and when its first message may not have arrived", async () => {
    const busy = fakeNode(proposed, {
      "threads.send": { code: "TURN_IN_PROGRESS", message: "running" },
    });
    await expect(
      implementPlan({ threads: busy.threads }, { target, threadId: "t1", newThread: false }),
    ).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
    const dropped = fakeNode(proposed, {
      "threads.send": { code: "DISCONNECTED", message: "The connection closed" },
    });
    expect(
      await implementPlan(
        { threads: dropped.threads },
        { target, threadId: "t1", newThread: true },
      ),
    ).toEqual({ threadId: "t2", uncertain: "The connection closed" });
  });

  it("refuses a plan whose turn failed, also for a new thread", async () => {
    const failed = [
      ...proposed.filter((event) => event.type !== ThreadEvents.turnCompleted),
      { type: ThreadEvents.turnFailed, payload: { turnId: "u1", error: "boom" } },
    ];
    const { threads, calls } = fakeNode(failed);
    await expect(
      implementPlan({ threads }, { target, threadId: "t1", newThread: true }),
    ).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
    expect(calls.some((call) => call.method === "threads.create")).toBe(false);
  });

  it("refuses a thread without a plan to implement", async () => {
    const { threads, calls } = fakeNode(
      proposed.filter((event) => event.type !== ThreadEvents.planProposed),
    );
    await expect(
      implementPlan({ threads }, { target, threadId: "t1", newThread: false }),
    ).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
    expect(calls.some((call) => call.method === "threads.send")).toBe(false);
  });
});
