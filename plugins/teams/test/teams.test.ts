import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  MESSAGES_STREAM,
  MessageEvents,
  TEAMS_STREAM,
  TeamEvents,
  type AgentRecord,
  type TeamRecord,
  type TeamRoster,
} from "@jhin/agent-api";
import { definePlugin, z } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createMemoryNetwork,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  startMeshNode,
  testManifest,
  type TestKernel,
  type TestPlugin,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import agents from "@jhin/plugin-agents";
import fake from "@jhin/plugin-agent-fake";
import threads from "@jhin/plugin-threads";
import teams from "../src/index.ts";
import { mergeLayers } from "../src/spec.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;
const FIXTURE = Path.join(import.meta.dirname, "fixtures", "workshop");

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const FAKE = "jhin.agent-fake";
const lead = { role: "Plans", runtime: FAKE };
const builder = { role: "Builds", runtime: FAKE, instructions: "Prove it." };

/** `host.config.get` and `.patch` over the test kernel's layers, as a node host writes its files. */
function hostConfig(kernel: () => TestKernel, layers: Record<string, Record<string, unknown>>) {
  return {
    manifest: testManifest("test.host-config", { side: "server" }),
    definition: definePlugin({
      activate(context) {
        context.commands.register({
          name: "host.config.get",
          description: "test",
          input: z.object({ section: z.string() }),
          output: z.unknown(),
          handler: ({ section }) => ({
            layers: { node: layers["node"]?.[section], project: layers["project"]?.[section] },
          }),
        });
        context.commands.register({
          name: "host.config.patch",
          description: "test",
          input: z.object({
            layer: z.enum(["node", "project"]),
            section: z.string(),
            values: z.record(z.string(), z.unknown()),
          }),
          output: z.unknown(),
          handler: ({ layer, section, values }) => {
            const current = layers[layer] ?? {};
            layers[layer] = {
              ...current,
              [section]: { ...(current[section] as object | undefined), ...values },
            };
            kernel().config.setLayer(layer, layers[layer]!);
            return { applied: true, at: Date.now() };
          },
        });
      },
    }),
  };
}

/** The plugins of a node with agents and teams, on its own data folder. */
function nodePlugins(nodeId: string, layers: Record<string, Record<string, unknown>>) {
  const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-teams-${nodeId}-`));
  let kernel: TestKernel | undefined;
  const plugins: TestPlugin[] = [
    mockCapability("host.paths", {
      home: data,
      dataDir: (id: string) => {
        Fs.mkdirSync(Path.join(data, id), { recursive: true });
        return Path.join(data, id);
      },
    }),
    mockCapability("host.identity", { nodeId }),
    { manifest: manifest("threads"), definition: threads },
    { manifest: manifest("agent-fake"), definition: fake },
    hostConfig(() => kernel!, layers),
    { manifest: manifest("agents"), definition: agents },
    { manifest: manifest("teams"), definition: teams },
  ];
  return { plugins, data, setKernel: (value: TestKernel) => (kernel = value) };
}

async function node(
  options: {
    teams?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    bundle?: boolean;
  } = {},
) {
  const storage = memoryStoragePlugin();
  const layers: Record<string, Record<string, unknown>> = {
    node: {
      "jhin.threads": { defaultAgent: FAKE },
      ...(options.agents === undefined ? {} : { "jhin.agents": { agents: options.agents } }),
      ...(options.teams === undefined ? {} : { "jhin.teams": { teams: options.teams } }),
    },
  };
  const base = nodePlugins("node-a", layers);
  const bundle: TestPlugin[] =
    options.bundle === true
      ? [
          {
            manifest: JSON.parse(Fs.readFileSync(Path.join(FIXTURE, "package.json"), "utf8")).jhin,
            definition: (await import(Path.join(FIXTURE, "index.js"))).default,
          },
        ]
      : [];
  const kernel = await createTestKernel({
    plugins: [storage, ...base.plugins, ...bundle],
    config: layers,
  });
  base.setKernel(kernel);
  const { client } = connectInMemory(kernel, { log: storage.storage.log });
  stops.push(async () => {
    client.close();
    await kernel.stop();
  });
  return { kernel, client, data: base.data, layers };
}

/** Follows a stream; `until(type)` resolves with the first event of that type, seen or future. */
function watch(client: ReturnType<typeof connectInMemory>["client"], stream: string) {
  const events: StoredEvent[] = [];
  const waiters: { type: string; resolve: (event: StoredEvent) => void }[] = [];
  client.subscribe(stream, {}, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.type === event.type)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  const until = (type: string) => {
    const seen = events.find((event) => event.type === type);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<StoredEvent>((resolve) => waiters.push({ type, resolve }));
  };
  return { events, until };
}

interface Up {
  roster: TeamRoster;
  members: {
    member: string;
    address: string;
    result?: string;
    resumed?: boolean;
    written?: string[];
    error?: { code: string };
  }[];
}

describe("teams (A5)", () => {
  it("merges layers as config does: objects by key, arrays replaced", () => {
    expect(
      mergeLayers(
        { lead: "a", agents: { a: { role: "x", skills: ["s"] } } },
        { agents: { a: { skills: ["t"] }, b: { role: "y" } } },
      ),
    ).toEqual({ lead: "a", agents: { a: { role: "x", skills: ["t"] }, b: { role: "y" } } });
  });

  it("puts a team up as defined agents told about their team, idempotently (D683–D685)", async () => {
    const { client } = await node({
      teams: { workshop: { lead: "lead", culture: "Ask first.", agents: { lead, builder } } },
    });
    const stream = watch(client, TEAMS_STREAM);
    const up = await client.call<Up>("teams.up", { teamId: "workshop" });
    expect(up.members).toEqual([
      expect.objectContaining({
        member: "lead",
        address: "jhin://node-a/agents/workshop-lead",
        result: "defined",
      }),
      expect.objectContaining({
        member: "builder",
        address: "jhin://node-a/agents/workshop-builder",
        result: "defined",
      }),
    ]);
    expect((await stream.until(TeamEvents.up)).payload).toMatchObject({
      teamId: "workshop",
      lead: "lead",
    });

    const agent = await client.call<AgentRecord>("agents.get", { agentId: "workshop-builder" });
    expect(agent).toMatchObject({ role: "Builds", runtimeId: FAKE });
    expect(agent.instructions).toContain("You are builder@workshop");
    expect(agent.instructions).toContain(
      "lead@workshop (jhin://node-a/agents/workshop-lead): Plans (the lead)",
    );
    expect(agent.instructions).toContain("Your lead is lead@workshop");
    expect(agent.instructions).toContain("Ask first.");
    expect(agent.instructions).toMatch(/Prove it\.$/);
    const leadAgent = await client.call<AgentRecord>("agents.get", { agentId: "workshop-lead" });
    // Owner-only decisions reach the owner's inbox (D688).
    expect(leadAgent.instructions).toContain("agents_ask to jhin://node-a/owner");

    const again = await client.call<Up>("teams.up", { teamId: "workshop" });
    expect(again.members.map((member) => member.result)).toEqual(["unchanged", "unchanged"]);

    const list = await client.call<{ teams: TeamRecord[] }>("teams.list", {});
    expect(list.teams).toEqual([
      expect.objectContaining({
        teamId: "workshop",
        source: "config",
        lead: "lead",
        culture: "Ask first.",
        upAt: again.roster.upAt,
      }),
    ]);
    expect(list.teams[0]!.members.map((member) => member.alias)).toEqual([
      "lead@workshop",
      "builder@workshop",
    ]);
  });

  it("updates a member when the spec changes, and clears what it dropped (D685)", async () => {
    const { client, kernel, layers } = await node({
      teams: { workshop: { lead: "lead", agents: { lead, builder: { ...builder, model: "m1" } } } },
    });
    await client.call("teams.up", { teamId: "workshop" });
    layers["node"]!["jhin.teams"] = {
      teams: { workshop: { lead: "lead", agents: { lead, builder } } },
    };
    kernel.config.setLayer("node", layers["node"]!);
    const up = await client.call<Up>("teams.up", { teamId: "workshop" });
    expect(up.members.map((member) => member.result)).toEqual(["unchanged", "updated"]);
    const agent = await client.call<AgentRecord>("agents.get", { agentId: "workshop-builder" });
    expect(agent.model).toBeUndefined();
  });

  it("resolves aliases, and messages reach a member by its alias (D687)", async () => {
    const { client } = await node({
      teams: { workshop: { lead: "lead", agents: { lead, builder } } },
    });
    await expect(client.call("teams.resolve", { alias: "builder@workshop" })).rejects.toMatchObject(
      {
        code: "TEAM_NOT_UP",
      },
    );
    await client.call("teams.up", { teamId: "workshop" });
    expect(await client.call("teams.resolve", { alias: "builder@workshop" })).toEqual({
      address: "jhin://node-a/agents/workshop-builder",
      teamId: "workshop",
      member: "builder",
    });
    await expect(client.call("teams.resolve", { alias: "qa@workshop" })).rejects.toMatchObject({
      code: "MEMBER_NOT_FOUND",
    });
    await expect(client.call("teams.resolve", { alias: "nobody" })).rejects.toMatchObject({
      code: "ALIAS_INVALID",
    });

    const messages = watch(client, MESSAGES_STREAM);
    const sent = await client.call<{ message: { to: string }; delivery: { agentId: string } }>(
      "agents.send",
      { to: "builder@workshop", body: "Slice 3 is yours." },
    );
    expect(sent.message.to).toBe("jhin://node-a/agents/workshop-builder");
    expect(sent.delivery.agentId).toBe("workshop-builder");
    await messages.until(MessageEvents.delivered);
  });

  it("stops a team through its agents and resumes it on up (D689)", async () => {
    const { client } = await node({
      teams: { workshop: { lead: "lead", agents: { lead, builder } } },
    });
    await client.call("teams.up", { teamId: "workshop" });
    const stream = watch(client, TEAMS_STREAM);
    const down = await client.call<{ members: { member: string; stoppedAt?: string }[] }>(
      "teams.down",
      { teamId: "workshop" },
    );
    expect(down.members.every((member) => member.stoppedAt !== undefined)).toBe(true);
    await stream.until(TeamEvents.down);
    const stopped = await client.call<{ status: Record<string, string>; downAt?: string }>(
      "teams.get",
      { teamId: "workshop" },
    );
    expect(stopped.status).toEqual({ lead: "stopped", builder: "stopped" });
    expect(stopped.downAt).toBeDefined();

    const up = await client.call<Up>("teams.up", { teamId: "workshop" });
    expect(up.members.map((member) => member.resumed)).toEqual([true, true]);
    const running = await client.call<{ status: Record<string, string> }>("teams.get", {
      teamId: "workshop",
    });
    expect(running.status).toEqual({ lead: "idle", builder: "idle" });
  });

  it("never takes over an agent the team did not define (D683)", async () => {
    const { client } = await node({
      agents: { "workshop-builder": { role: "Mine", runtime: FAKE } },
      teams: { workshop: { lead: "lead", agents: { lead, builder } } },
    });
    const up = await client.call<Up>("teams.up", { teamId: "workshop" });
    expect(up.members[0]!.result).toBe("defined");
    expect(up.members[1]!.error?.code).toBe("AGENT_EXISTS");
    const agent = await client.call<AgentRecord>("agents.get", { agentId: "workshop-builder" });
    expect(agent.role).toBe("Mine");
  });

  it("lists an invalid team with its error and refuses to put it up (D682)", async () => {
    const { client } = await node({ teams: { broken: { lead: "qa", agents: { lead } } } });
    const list = await client.call<{ teams: TeamRecord[] }>("teams.list", {});
    expect(list.teams[0]).toMatchObject({ teamId: "broken", members: [] });
    expect(list.teams[0]!.error).toContain("lead");
    await expect(client.call("teams.up", { teamId: "broken" })).rejects.toMatchObject({
      code: "TEAM_INVALID",
    });
    await expect(client.call("teams.up", { teamId: "nope" })).rejects.toMatchObject({
      code: "TEAM_NOT_FOUND",
    });
  });

  it("installs a bundle as a plugin, layered under config, with its files (D686)", async () => {
    const { client, data } = await node({
      bundle: true,
      // The node's layer changes one field of the bundle's team.
      teams: { workshop: { agents: { builder: { model: "m2" } } } },
    });
    const list = await client.call<{ teams: TeamRecord[] }>("teams.list", {});
    expect(list.teams[0]).toMatchObject({
      teamId: "workshop",
      title: "Workshop",
      source: "bundle",
      bundle: "team.workshop",
      culture: "We ask before we guess, and we read the map before we build.\n",
    });
    expect(list.teams[0]!.members.find((member) => member.member === "builder")?.model).toBe("m2");

    const up = await client.call<Up>("teams.up", { teamId: "workshop" });
    expect(up.members.find((member) => member.member === "builder")?.written).toEqual([
      "start.md",
      "lore/moonbase.md",
    ]);
    expect(up.members.find((member) => member.member === "lead")?.written).toEqual([
      "lore/moonbase.md",
    ]);
    const agent = await client.call<AgentRecord>("agents.get", { agentId: "workshop-builder" });
    expect(agent.instructions).toContain("We ask before we guess");
    expect(agent.knowledgeDir?.startsWith(data)).toBe(true);
    const start = Path.join(agent.knowledgeDir!, "start.md");
    expect(Fs.readFileSync(start, "utf8")).toContain("Read docs/map.md first.");

    // What the agent learnt is never overwritten.
    Fs.writeFileSync(start, "Learnt: read the plan too.");
    const again = await client.call<Up>("teams.up", { teamId: "workshop" });
    expect(again.members.every((member) => member.written?.length === 0)).toBe(true);
    expect(Fs.readFileSync(start, "utf8")).toBe("Learnt: read the plan too.");
  });
});

describe("teams across the mesh (A5)", () => {
  const meshNode = async (
    network: ReturnType<typeof createMemoryNetwork>,
    id: string,
    config: Record<string, unknown> = {},
  ) => {
    const layers: Record<string, Record<string, unknown>> = {
      node: { "jhin.threads": { defaultAgent: FAKE }, ...config },
    };
    const base = nodePlugins(id, layers);
    const started = await startMeshNode(network, id, { config: layers, plugins: base.plugins });
    base.setKernel(started.kernel);
    stops.push(() => started.stop());
    return started;
  };

  it("puts a member on another node, which resolves the team's aliases, and stops it there (D685, D689)", async () => {
    const network = createMemoryNetwork();
    const a = await meshNode(network, "a", {
      "jhin.teams": {
        teams: { workshop: { lead: "lead", agents: { lead, builder: { ...builder, node: "b" } } } },
      },
    });
    const b = await meshNode(network, "b");
    await b.join(a);

    const up = (await a.kernel.commands.execute("teams.up", { teamId: "workshop" })) as Up;
    expect(up.members).toEqual([
      expect.objectContaining({ address: "jhin://a/agents/workshop-lead", result: "defined" }),
      expect.objectContaining({ address: "jhin://b/agents/workshop-builder", result: "defined" }),
    ]);
    const onB = (await b.kernel.commands.execute("agents.get", {
      agentId: "workshop-builder",
    })) as AgentRecord;
    expect(onB.instructions).toContain("lead@workshop (jhin://a/agents/workshop-lead)");
    expect(
      await b.kernel.commands.execute("teams.resolve", { alias: "lead@workshop" }),
    ).toMatchObject({
      address: "jhin://a/agents/workshop-lead",
    });

    const status = (await a.kernel.commands.execute("teams.get", { teamId: "workshop" })) as {
      status: Record<string, string>;
    };
    expect(status.status).toEqual({ lead: "idle", builder: "idle" });

    await a.kernel.commands.execute("teams.down", { teamId: "workshop" });
    const stopped = (await b.kernel.commands.execute("agents.get", {
      agentId: "workshop-builder",
    })) as AgentRecord;
    expect(stopped.stoppedAt).toBeDefined();
  });
});
