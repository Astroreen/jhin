import { describe, expect, it } from "vite-plus/test";

import {
  AgentCommands,
  AgentEvents,
  AgentId,
  AgentsConfig,
  agentAddress,
  agentKnowledgeDir,
  agentStatusOf,
  parseAgentAddress,
} from "../src/index.ts";

describe("agent contract", () => {
  it("round-trips an agent address", () => {
    const address = agentAddress("node-1", "builder");
    expect(address).toBe("jhin://node-1/agents/builder");
    expect(parseAgentAddress(address)).toEqual({ nodeId: "node-1", agentId: "builder" });
    expect(parseAgentAddress("jhin://node-1/threads/t1")).toBeUndefined();
    expect(parseAgentAddress("jhin://node-1/agents/builder/extra")).toBeUndefined();
    // A runtime's id has dots; nothing that could leave a folder is an agent.
    expect(parseAgentAddress("jhin://node-1/agents/jhin.agent-claude")?.agentId).toBe(
      "jhin.agent-claude",
    );
    for (const id of ["..", ".", "Foo%20Bar", ".hidden"]) {
      expect(parseAgentAddress(`jhin://node-1/agents/${id}`)).toBeUndefined();
    }
  });

  it("bounds agent ids and keeps the knowledge folder inside .jhin/agents", () => {
    for (const id of ["builder", "b", "qa-2", `a${"b".repeat(62)}`]) {
      expect(AgentId.safeParse(id).success).toBe(true);
    }
    for (const id of ["", "2fast", "Builder", "a.b", "a/b", "..", `a${"b".repeat(63)}`]) {
      expect(AgentId.safeParse(id).success).toBe(false);
    }
    expect(agentKnowledgeDir("builder")).toBe(".jhin/agents/builder");
    expect(() => agentKnowledgeDir("..")).toThrow();
  });

  it("validates the inputs and outputs of the commands", () => {
    const define = AgentCommands["agents.define"].input;
    expect(
      define.parse({ agentId: "builder", role: "Builds", runtime: "jhin.agent-claude" }),
    ).toEqual({ agentId: "builder", role: "Builds", runtime: "jhin.agent-claude" });
    expect(define.safeParse({ agentId: "builder", runtime: "x" }).success).toBe(false);
    expect(
      define.safeParse({ agentId: "builder", role: "r", runtime: "x", layer: "device" }).success,
    ).toBe(false);

    const generation = { number: 1, threadId: "t1", startedAt: "2026-10-21T00:00:00.000Z" };
    const record = {
      agentId: "builder",
      address: "jhin://n/agents/builder",
      kind: "defined",
      title: "Builder",
      role: "Builds",
      runtimeId: "jhin.agent-claude",
      skills: [],
      generations: [generation],
    };
    expect(
      AgentCommands["agents.get"].output.parse({ ...record, status: "working" }),
    ).toMatchObject({ status: "working" });
    expect(
      AgentCommands["agents.get"].output.safeParse({ ...record, status: "busy" }).success,
    ).toBe(false);
    expect(AgentCommands["agents.rotate"].output.parse({ generation })).toEqual({ generation });
    expect(
      AgentCommands["agents.rotate"].output.safeParse({ generation: { ...generation, number: 0 } })
        .success,
    ).toBe(false);
    // Commands on an existing agent take its id or its address (D603).
    for (const name of ["agents.get", "agents.rotate", "agents.remove", "agents.stop"] as const) {
      expect(
        AgentCommands[name].input.safeParse({ agentId: "jhin://n/agents/builder" }).success,
      ).toBe(true);
    }
    expect(Object.values(AgentEvents).every((type) => type.startsWith("agents."))).toBe(true);
  });

  it("reads a generation's status from its thread's latest turn", () => {
    expect(agentStatusOf(undefined)).toBe("idle");
    expect(agentStatusOf({ status: "running" })).toBe("working");
    expect(agentStatusOf({ status: "waiting" })).toBe("waiting");
    expect(agentStatusOf({ status: "failed" })).toBe("idle");
  });

  it("defaults the section and refuses ids that are no agent ids", () => {
    expect(AgentsConfig.parse({})).toEqual({ agents: {} });
    expect(
      AgentsConfig.parse({ agents: { builder: { role: "Builds", runtime: "jhin.agent-fake" } } }),
    ).toEqual({ agents: { builder: { role: "Builds", runtime: "jhin.agent-fake" } } });
    expect(
      AgentsConfig.safeParse({ agents: { "jhin.agent-fake": { role: "x", runtime: "y" } } })
        .success,
    ).toBe(false);
  });

  it("takes partial updates with fields to clear, never the required ones", () => {
    const update = AgentCommands["agents.update"].input;
    expect(update.parse({ agentId: "builder", unset: ["model"] })).toEqual({
      agentId: "builder",
      unset: ["model"],
    });
    expect(update.safeParse({ agentId: "builder", unset: ["role"] }).success).toBe(false);
    expect(update.safeParse({ agentId: "builder", model: "m", unset: ["model"] }).success).toBe(
      false,
    );
  });
});
