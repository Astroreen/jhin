import { describe, expect, it } from "vite-plus/test";

import {
  AgentCommands,
  AgentsConfig,
  agentAddress,
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
  });
});
