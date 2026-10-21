import { AgentEvents, ThreadEvents, type AgentRecord } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import { applyAgentEvent, applyThreadEvent, statusOf, type NodeAgents } from "../src/lib/agents.ts";

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  agentId: "builder",
  address: "jhin://n/agents/builder",
  kind: "defined",
  title: "Builder",
  role: "Builds",
  runtimeId: "jhin.agent-fake",
  skills: [],
  projectId: "scratch",
  generations: [{ number: 1, threadId: "t1", startedAt: "2026-10-21T00:00:00.000Z" }],
  ...overrides,
});
const empty: NodeAgents = { status: "ready", agents: [], turns: {} };

describe("the agents of a node", () => {
  it("follows the agents stream: defined, updated, removed", () => {
    let state = applyAgentEvent(empty, { type: AgentEvents.defined, payload: agent() });
    state = applyAgentEvent(state, {
      type: AgentEvents.defined,
      payload: agent({ agentId: "analyst", title: "Analyst" }),
    });
    expect(state.agents.map((item) => item.agentId)).toEqual(["analyst", "builder"]);
    state = applyAgentEvent(state, {
      type: AgentEvents.updated,
      payload: agent({ role: "Reviews" }),
    });
    expect(state.agents.find((item) => item.agentId === "builder")?.role).toBe("Reviews");
    state = applyAgentEvent(state, { type: AgentEvents.removed, payload: { agentId: "analyst" } });
    expect(state.agents.map((item) => item.agentId)).toEqual(["builder"]);
    // Events it does not keep a record of change nothing.
    expect(applyAgentEvent(state, { type: AgentEvents.generationStarted, payload: {} })).toBe(
      state,
    );
  });

  it("takes a generation's status from its thread in the threads index (D608)", () => {
    const state = { ...empty, agents: [agent()] };
    expect(statusOf(agent(), state)).toBe("idle");
    const running = applyThreadEvent(state, {
      type: ThreadEvents.threadUpdated,
      payload: { id: "t1", generationOf: "builder", lastTurn: { status: "running" } },
    });
    expect(statusOf(agent(), running)).toBe("working");
    const waiting = applyThreadEvent(running, {
      type: ThreadEvents.threadUpdated,
      payload: { id: "t1", generationOf: "builder", lastTurn: { status: "waiting" } },
    });
    expect(statusOf(agent(), waiting)).toBe("waiting");
    // Threads that are no generation are none of its business.
    expect(
      applyThreadEvent(waiting, {
        type: ThreadEvents.threadUpdated,
        payload: { id: "t2", lastTurn: { status: "running" } },
      }),
    ).toBe(waiting);
    // Stopped and unavailable come from the record, before the thread.
    expect(statusOf(agent({ stoppedAt: "2026-10-21T01:00:00.000Z" }), waiting)).toBe("stopped");
    const { projectId: _projectId, ...homeless } = agent();
    expect(statusOf(homeless, waiting)).toBe("unavailable");
  });
});
