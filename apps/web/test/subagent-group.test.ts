// Subagents in the UI (docs/plans/orchestration.md, D1161–D1163).
import { OrchestrationThreadEvents, ThreadEvents } from "@jhin/agent-api";
import type { ThreadRecord } from "@jhin/client-api";
import type { StoredEvent } from "@jhin/storage-api";
import { describe, expect, it } from "vite-plus/test";

import { adjacentExtensions, type TurnBlock } from "../src/lib/timeline.ts";
import { runningSubagents } from "../src/plugins/chat/lineage.tsx";
import {
  subagentGroupTiming,
  subagentPreview,
  summarizeSubagentStatuses,
} from "../src/plugins/orchestration/rows.tsx";
import type { DelegationView } from "../src/plugins/orchestration/store.ts";
import { childDetails, subagentMember, subagentRun } from "../src/plugins/orchestration/view.tsx";

const event = (sequence: number, type: string, payload: unknown): StoredEvent => ({
  stream: "thread/p",
  sequence,
  type,
  payload: payload as StoredEvent["payload"],
  at: "2026-10-22T10:00:00.000Z",
});
const delegated = (sequence: number, taskId = `t${sequence}`) =>
  event(sequence, OrchestrationThreadEvents.taskDelegated, {
    taskId,
    childThreadId: `c${sequence}`,
    title: `task ${sequence}`,
    agentId: "jhin.agent-fake",
  });
const provider = (sequence: number) =>
  event(sequence, ThreadEvents.subagentStarted, {
    turnId: "u",
    subagentId: `s${sequence}`,
    childThreadId: `c${sequence}`,
    title: `sub ${sequence}`,
  });
const launched = (sequence: number) =>
  event(sequence, OrchestrationThreadEvents.threadLaunched, { threadId: "x", title: "x" });

const extension = (item: StoredEvent): TurnBlock => ({
  kind: "extension",
  item: { kind: "extension", event: item, at: item.at },
});
const work = { kind: "work", entries: [] } as TurnBlock;
const message = { kind: "message", item: {}, final: false } as unknown as TurnBlock;

const thread = (id: string, more: Partial<ThreadRecord> = {}) =>
  ({
    id,
    projectId: "p",
    title: id,
    createdAt: "2026-10-22T10:00:00.000Z",
    ...more,
  }) as ThreadRecord;

describe("the events a turn item stands among (D1161)", () => {
  it("groups other plugins' events across the agent's work, and starts again at a message", () => {
    const [a, b, c, d] = [delegated(1), delegated(3), provider(5), delegated(8)];
    const groups = adjacentExtensions([
      extension(a),
      work,
      extension(b),
      extension(c),
      message,
      work,
      extension(d),
    ]);
    expect(groups.get(1)).toEqual([a, b, c]);
    expect(groups.get(5)).toEqual([a, b, c]);
    expect(groups.get(8)).toEqual([d]);
  });
});

describe("the subagent marks in a row (D1161)", () => {
  it("folds tasks and a runtime's subagents, and stops at any other mark", () => {
    const marks = [delegated(1), provider(2), delegated(3), launched(4), delegated(5)];
    expect(subagentRun(marks[1]!, marks).map((mark) => mark.sequence)).toEqual([1, 2, 3]);
    expect(subagentRun(marks[4]!, marks).map((mark) => mark.sequence)).toEqual([5]);
    expect(subagentRun(marks[3]!, marks).map((mark) => mark.sequence)).toEqual([4]);
    // A client older than D1161 gives no group: the mark stands alone.
    expect(subagentRun(marks[0]!, undefined)).toEqual([marks[0]]);
    // A group that does not name the mark (a partial one) leaves it alone, not hidden.
    expect(subagentRun(marks[2]!, [marks[0]!, marks[1]!])).toEqual([marks[2]]);
  });

  it("summarizes the statuses and the elapsed time as T3's group does", () => {
    expect(
      summarizeSubagentStatuses(["running", "starting", "completed", "failed", "cancelled"]),
    ).toBe("2 working · 1 done · 1 failed · 1 stopped");
    // A member whose status is not known counts nowhere.
    expect(summarizeSubagentStatuses(["unknown", "cancelled", "interrupted"])).toBe("2 stopped");
    const settled = subagentGroupTiming([
      {
        status: "completed",
        run: { startedAt: "2026-10-22T10:00:05.000Z", endedAt: "2026-10-22T10:01:00.000Z" },
      },
      {
        status: "failed",
        run: { startedAt: "2026-10-22T10:00:00.000Z", endedAt: "2026-10-22T10:00:30.000Z" },
      },
    ]);
    expect(settled).toEqual({
      status: "completed",
      startedAt: "2026-10-22T10:00:00.000Z",
      endedAt: "2026-10-22T10:01:00.000Z",
    });
    const live = subagentGroupTiming([
      { status: "running", run: { startedAt: "2026-10-22T10:00:00.000Z" } },
      { status: "completed", run: { startedAt: "2026-10-22T10:00:00.000Z", endedAt: "x" } },
    ]);
    expect(live).toEqual({ status: "running", startedAt: "2026-10-22T10:00:00.000Z" });
    // Settled, but one member's end is unknown (no record of its task): no time at all.
    expect(
      subagentGroupTiming([
        { status: "unknown", run: undefined },
        { status: "completed", run: { startedAt: "2026-10-22T10:00:00.000Z", endedAt: "x" } },
      ]),
    ).toEqual({ status: "completed" });
  });
});

describe("a subagent's hover card (D1162)", () => {
  it("names the child's agent, model, effort and its own worktree", () => {
    const parent = thread("p", { worktreePath: "/repo" });
    const child = thread("c", {
      agentId: "jhin.agent-claude",
      model: "opus",
      modelOptions: [
        { id: "fastMode", value: true },
        { id: "effort", value: "high" },
      ],
      worktreePath: "/home/me/.jhin/worktrees/repo/feature-x/",
    });
    expect(childDetails(child, parent)).toEqual({
      agentId: "jhin.agent-claude",
      model: "opus",
      effort: "high",
      worktree: "feature-x",
    });
    // The parent's own checkout is not named; the task's agent and model stand in for a missing child.
    expect(
      childDetails(thread("c", { worktreePath: "/repo" }), parent, {
        agentId: "jhin.agent-fake",
        model: "echo",
      }),
    ).toEqual({ agentId: "jhin.agent-fake", model: "echo" });
  });

  it("previews a result on one line, at most 280 characters", () => {
    expect(subagentPreview(" Found\n\n  three files ")).toBe("Found three files");
    expect(subagentPreview(undefined)).toBeNull();
    const long = subagentPreview("x".repeat(300));
    expect(long).toBe(`${"x".repeat(280)}…`);
  });

  it("reads a task's row from its record, and a runtime's subagent from its thread", () => {
    const view: DelegationView = {
      status: "ready",
      workflows: new Map(),
      tasks: new Map([
        [
          "t1",
          {
            taskId: "t1",
            parentThreadId: "p",
            childThreadId: "c1",
            title: "look",
            agentId: "jhin.agent-fake",
            model: "echo",
            status: "completed",
            summary: "Echo: look",
            createdAt: "2026-10-22T10:00:00.000Z",
            updatedAt: "2026-10-22T10:00:09.000Z",
            endedAt: "2026-10-22T10:00:09.000Z",
          },
        ],
      ]),
    };
    const opened: string[] = [];
    const context = {
      view,
      threads: [
        thread("c2", {
          title: "survey",
          agentId: "jhin.agent-claude",
          lastTurn: {
            turnId: "u",
            status: "running",
            at: "2026-10-22T10:00:01.000Z",
            agentId: "jhin.agent-claude",
            progress: "Reading the map",
          },
        }),
      ],
      parent: thread("p"),
      open: (id: string) => opened.push(id),
    };
    const task = subagentMember(delegated(1, "t1"), context);
    expect(task).toMatchObject({
      title: "look",
      status: "completed",
      run: { summary: "Echo: look", endedAt: "2026-10-22T10:00:09.000Z" },
      details: { agentId: "jhin.agent-fake", model: "echo" },
    });
    const sub = subagentMember(provider(2), context);
    expect(sub).toMatchObject({
      title: "survey",
      status: "running",
      // Its runtime's progress line (D1344).
      run: { startedAt: "2026-10-22T10:00:00.000Z", progress: "Reading the map" },
      details: { agentId: "jhin.agent-claude" },
    });
    sub.onOpen?.();
    expect(opened).toEqual(["c2"]);
  });
});

describe("Lineage · N running (D1163)", () => {
  it("counts the thread's subagents whose turn runs, not waiting, archived ones nor forks", () => {
    const turn = (status: "running" | "waiting" | "completed") => ({
      lastTurn: { turnId: "u", status, at: "x", agentId: "a" },
    });
    const parent = thread("p");
    const threads = [
      parent,
      thread("a", { parentThreadId: "p", relationshipToParent: "subagent", ...turn("running") }),
      thread("b", { parentThreadId: "p", relationshipToParent: "subagent", ...turn("running") }),
      thread("c", { parentThreadId: "p", relationshipToParent: "subagent", ...turn("waiting") }),
      thread("d", { parentThreadId: "p", relationshipToParent: "subagent", ...turn("completed") }),
      thread("e", { forkedFrom: { threadId: "p", turnId: "u" }, ...turn("running") }),
      thread("f", { parentThreadId: "x", relationshipToParent: "subagent", ...turn("running") }),
      thread("g", {
        parentThreadId: "p",
        relationshipToParent: "subagent",
        archivedAt: "x",
        ...turn("running"),
      }),
    ];
    expect(runningSubagents(parent, threads)).toBe(2);
  });
});
