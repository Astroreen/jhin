import { describe, expect, it } from "vite-plus/test";

import {
  TeamBundleSpec,
  TeamCommands,
  TeamFile,
  TeamSpec,
  TeamsConfig,
  parseTeamAlias,
  teamAgentId,
  teamAlias,
} from "../src/index.ts";

const workshop = {
  lead: "lead",
  culture: "We ask before we guess.",
  agents: {
    lead: { role: "Talks to the owner and plans", runtime: "jhin.agent-claude" },
    builder: { role: "Builds slices and proves them", runtime: "jhin.agent-codex", node: "box" },
  },
};

describe("teams contract", () => {
  it("names a member's agent and alias after its team (D683, D687)", () => {
    expect(teamAgentId("workshop", "builder")).toBe("workshop-builder");
    expect(teamAlias("workshop", "builder")).toBe("builder@workshop");
    expect(parseTeamAlias("builder@workshop")).toEqual({ member: "builder", teamId: "workshop" });
    expect(parseTeamAlias("jhin://n/agents/builder")).toBeUndefined();
    expect(parseTeamAlias("Builder@workshop")).toBeUndefined();
    expect(parseTeamAlias("a@b@c")).toBeUndefined();
    expect(() => teamAgentId("workshop", "Builder")).toThrow();
  });

  it("validates a spec, whose lead must be one of its agents (D681)", () => {
    expect(TeamSpec.parse(workshop).agents.builder?.node).toBe("box");
    expect(TeamSpec.safeParse({ ...workshop, lead: "qa" }).success).toBe(false);
    expect(
      TeamSpec.safeParse({ ...workshop, agents: { Lead: workshop.agents.lead } }).success,
    ).toBe(false);
  });

  it("takes any part of a spec in a config layer, to merge over a bundle's (D682)", () => {
    const config = TeamsConfig.parse({
      teams: { workshop: { agents: { builder: { node: "x" } } } },
    });
    expect(config.teams.workshop?.agents?.builder).toEqual({ node: "x" });
    expect(TeamsConfig.parse({}).teams).toEqual({});
    expect(TeamBundleSpec.parse({ id: "workshop", ...workshop }).id).toBe("workshop");
  });

  it("keeps files inside the agent's knowledge folder (D685)", () => {
    expect(TeamFile.safeParse({ path: "lore/moonbase.md", text: "" }).success).toBe(true);
    expect(TeamFile.safeParse({ path: "notes.md", text: "" }).success).toBe(true);
    for (const path of ["../x.md", "lore/../../x.md", "/etc/x.md", "a/b.md", "x.txt"]) {
      expect(TeamFile.safeParse({ path, text: "" }).success, path).toBe(false);
    }
  });

  it("joins a member with an empty file list by default", () => {
    const input = TeamCommands["teams.join"].input.parse({
      roster: {
        teamId: "workshop",
        lead: "lead",
        nodeId: "a",
        members: { lead: "jhin://a/agents/workshop-lead" },
        upAt: "2026-10-22T00:00:00.000Z",
      },
      member: "lead",
      definition: workshop.agents.lead,
    });
    expect(input.files).toEqual([]);
  });
});
