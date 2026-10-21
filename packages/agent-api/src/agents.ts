// Defined agents (docs/plans/agents.md#a1-agent-entity-d602d620): the
// persistent actors behind an address, their generations and the schemas of
// the `agents.*` commands, so every surface and every stacked workstream
// (A2 messaging, A5 teams) reads one contract.
import { z } from "@jhin/sdk";

import { INTERACTION_MODES, RUNTIME_MODES } from "./modes.ts";

/** The config section of defined agents (D604). */
export const AGENTS_CONFIG_SECTION = "jhin.agents";

/** The node's stream of agent changes: definitions and generations, not status (D608, D609). */
export const AGENTS_STREAM = "agents";

/** Event types of the `agents` stream (D609). */
export const AgentEvents = {
  /** `AgentRecord`: an agent was defined, by command or in a config file. */
  defined: "agents.agent.defined",
  /** `AgentRecord`: its definition changed, or a generation started. */
  updated: "agents.agent.updated",
  /** `{ agentId }`: its definition is gone; its generations and knowledge stay (D611). */
  removed: "agents.agent.removed",
  /** `{ agentId, generation, previous? }`: a new generation is current (D606). */
  generationStarted: "agents.generation.started",
  /** `{ agentId, at }`: the owner stopped the agent (D612). */
  stopped: "agents.agent.stopped",
  /** `{ agentId, at }`: the owner let a stopped agent work again (D612). */
  resumed: "agents.agent.resumed",
} as const;

/**
 * The mark on a thread that is a generation of an agent (D606, D741): the
 * thread record's `generationOf`, the id of the defined agent. Set once when
 * the thread is created, never changed. Threads mode leaves such threads out
 * of its lists and catalogs (A8: `includeGenerations`); the generation's
 * number lives in the agent's `AgentGeneration` records only.
 */
export const GenerationOf = z.string().min(1);
export type GenerationOf = z.output<typeof GenerationOf>;

/**
 * The id of a defined agent (D603): unique on its node among agents and
 * runtimes, part of its address and the name of its knowledge folder.
 */
export const AgentId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "lowercase letters, digits and -, starting with a letter");

/** `jhin://<nodeId>/agents/<id>` (D52, D603). */
export const agentAddress = (nodeId: string, agentId: string): string =>
  `jhin://${nodeId}/agents/${agentId}`;

/**
 * The id part of an agent address: a defined agent's id or a runtime's (which
 * may have dots, `jhin.agent-claude`), never `.` or `..`.
 */
const ADDRESS_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The node and agent of an address, or `undefined` when it is not an agent's. */
export function parseAgentAddress(
  address: string,
): { readonly nodeId: string; readonly agentId: string } | undefined {
  const match = /^jhin:\/\/([^/]+)\/agents\/([^/?#]+)$/.exec(address);
  if (match === null || !ADDRESS_AGENT.test(match[2]!)) return undefined;
  return { nodeId: match[1]!, agentId: match[2]! };
}

/**
 * Where a defined agent's inherited knowledge lives, relative to its home
 * project (D607). Throws for anything that is not an `AgentId`, so no id
 * leaves the folder.
 */
export function agentKnowledgeDir(agentId: string): string {
  return `.jhin/agents/${AgentId.parse(agentId)}`;
}

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
/** What defines an agent (D604): config, so it is layered and the settings page edits it. */
export const AgentDefinition = z.object({
  title: z
    .string()
    .min(1)
    .optional()
    .meta({ title: "Title", description: "How the agent is shown; its id when unset." }),
  role: z.string().min(1).meta({
    title: "Role",
    description: "A short job description, e.g. “Builds slices and proves them”.",
  }),
  runtime: z
    .string()
    .min(1)
    .meta({
      title: "Runtime",
      description: "The agent runtime that runs its turns, by id (see agents.list).",
      examples: ["jhin.agent-claude"],
    }),
  model: z
    .string()
    .min(1)
    .optional()
    .meta({ title: "Model", description: "One of the runtime's models; its default when unset." }),
  runtimeMode: z.enum(RUNTIME_MODES).optional().meta({ title: "Runtime mode" }),
  interactionMode: z.enum(INTERACTION_MODES).optional().meta({ title: "Interaction mode" }),
  instructions: z.string().optional().meta({
    title: "Instructions",
    description: "Told to every generation besides its role.",
  }),
  skills: z
    .array(z.string().min(1))
    .optional()
    .meta({ title: "Skills", description: "Skills the agent is told to use, by name (D613)." }),
  project: z.string().min(1).optional().meta({
    title: "Home project",
    description:
      "Where its generations run and its knowledge lives: a project's id or path; the scratch project when unset.",
  }),
});
export type AgentDefinition = z.output<typeof AgentDefinition>;

/** The `jhin.agents` section: defined agents by id (D604). */
export const AgentsConfig = z
  .object({
    agents: z
      .record(AgentId, AgentDefinition)
      .default({})
      .meta({ title: "Agents", description: "Defined agents of this node, by id." }),
  })
  .meta({
    title: "Agents",
    description:
      "Persistent agents with an address, a role and generations (docs/plans/agents.md).",
  });
export type AgentsConfig = z.output<typeof AgentsConfig>;

/** One generation of an agent: one of its threads, numbered from 1 (D606). */
export const AgentGeneration = z.object({
  number: z.number().int().positive(),
  threadId: z.string(),
  startedAt: z.string(),
  /** Why it started, as given to `agents.rotate`. */
  reason: z.string().optional(),
});
export type AgentGeneration = z.output<typeof AgentGeneration>;

/**
 * Where an agent is now (D608): working on a turn, waiting for the owner (an
 * approval or answers), idle, stopped by the owner (D612), or unable to run
 * (no such runtime or home project on the node).
 */
export const AGENT_STATUSES = ["idle", "working", "waiting", "stopped", "unavailable"] as const;
export const AgentStatus = z.enum(AGENT_STATUSES);
export type AgentStatus = z.output<typeof AgentStatus>;

/** Where a thread's latest turn is (the thread record's `lastTurn.status`, D57). */
export const TURN_STATUSES = ["running", "waiting", "completed", "interrupted", "failed"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** The status a generation's thread gives its agent, from the thread's latest turn. */
export function agentStatusOf(
  lastTurn: { readonly status: TurnStatus } | undefined,
): "idle" | "working" | "waiting" {
  if (lastTurn?.status === "running") return "working";
  if (lastTurn?.status === "waiting") return "waiting";
  return "idle";
}

/**
 * An agent as the `agents.*` commands and the `agents` stream report it
 * (D609): a defined agent, or a runtime as the implicit agent of the same id
 * (D601), which has no role, project or generations.
 */
export const AgentRecord = z.object({
  agentId: z.string(),
  address: z.string(),
  kind: z.enum(["defined", "runtime"]),
  title: z.string(),
  role: z.string().optional(),
  /** The runtime its turns run on; the agent's own id for a runtime. */
  runtimeId: z.string(),
  model: z.string().optional(),
  runtimeMode: z.enum(RUNTIME_MODES).optional(),
  interactionMode: z.enum(INTERACTION_MODES).optional(),
  instructions: z.string().optional(),
  skills: z.array(z.string()),
  /** The home project's id; absent while the configured project is not on the node. */
  projectId: z.string().optional(),
  /** The knowledge folder on the node, absolute (D607). */
  knowledgeDir: z.string().optional(),
  /** Every generation, oldest first; the last is current. */
  generations: z.array(AgentGeneration),
  /** Which config layer defines it; the highest when several do. */
  layer: z.string().optional(),
  /** When the owner stopped it; it takes no new work until resumed (D612). */
  stoppedAt: z.string().optional(),
});
export type AgentRecord = z.output<typeof AgentRecord>;

/** Error codes of the `agents.*` commands. */
export type AgentErrorCode =
  /** No agent with that id on this node. */
  | "AGENT_NOT_FOUND"
  /** `agents.define` of an id a defined agent already has. */
  | "AGENT_EXISTS"
  /** The id is a runtime's: a runtime is already the implicit agent of its id (D601). */
  | "AGENT_ID_TAKEN"
  /** A runtime is the implicit agent of that id and cannot be changed, rotated or removed. */
  | "AGENT_IS_RUNTIME"
  /** The address is another node's: call it there (`mesh.call`). `details.nodeId` names it. */
  | "AGENT_ELSEWHERE"
  /** The home project is not on this node, so no generation can start. */
  | "PROJECT_NOT_FOUND"
  /** The agent is stopped: resume it first (D612). */
  | "AGENT_STOPPED"
  /** The node cannot change its config (no `host.config.patch`), or the change lost (D50). */
  | "CONFIG_UNAVAILABLE";

/** An agent by id, or by an address of this node. */
const AgentRef = z.object({
  agentId: z.string().min(1).meta({ description: "An agent id, or an agent address of this node" }),
});

const Layer = z.enum(["node", "project"]);

/** The fields of a definition `agents.update` can clear. */
export const AGENT_OPTIONAL_FIELDS = [
  "title",
  "model",
  "runtimeMode",
  "interactionMode",
  "instructions",
  "skills",
  "project",
] as const;

/** Input and output schemas of the `agents.*` commands (D609); `agents.list` is in D610. */
export const AgentCommands = {
  "agents.get": {
    input: AgentRef,
    output: AgentRecord.extend({ status: AgentStatus }),
  },
  "agents.catalog": {
    input: z.object({}),
    /** Defined agents, and the head of the `agents` stream they reflect. */
    output: z.object({ head: z.number(), agents: z.array(AgentRecord) }),
  },
  "agents.define": {
    input: AgentDefinition.extend({
      agentId: AgentId,
      /** The config file to write; `node` by default. */
      layer: Layer.optional(),
    }),
    output: AgentRecord,
  },
  "agents.update": {
    input: AgentDefinition.partial()
      .extend({
        agentId: AgentRef.shape.agentId,
        /** Fields to clear, so they take their default again; never one the update sets. */
        unset: z.array(z.enum(AGENT_OPTIONAL_FIELDS)).optional(),
      })
      .refine(
        (input) =>
          (input.unset ?? []).every(
            (field) => (input as Record<string, unknown>)[field] === undefined,
          ),
        { message: "a field cannot be both set and unset", path: ["unset"] },
      ),
    output: AgentRecord,
  },
  "agents.remove": {
    input: AgentRef,
    output: z.object({ removed: z.boolean() }),
  },
  "agents.rotate": {
    input: AgentRef.extend({ reason: z.string().min(1).optional() }),
    output: z.object({ generation: AgentGeneration, previous: AgentGeneration.optional() }),
  },
  "agents.stop": {
    input: AgentRef,
    /** `interrupted`: whether a running turn of its current generation was stopped. */
    output: z.object({ stoppedAt: z.string(), interrupted: z.boolean() }),
  },
  "agents.resume": {
    input: AgentRef,
    output: z.object({ resumed: z.boolean() }),
  },
  "agents.generations": {
    input: AgentRef,
    output: z.array(
      AgentGeneration.extend({
        current: z.boolean(),
        /** The status of its thread: `unavailable` once the thread is gone. */
        status: AgentStatus,
        title: z.string().optional(),
      }),
    ),
  },
} as const;
