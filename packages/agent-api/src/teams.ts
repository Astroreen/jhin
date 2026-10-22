// Teams and team bundles (docs/plans/agents.md#a5-teams-and-team-bundles-d681d700):
// the team spec (config, layered over a bundle's), the roster of a team that
// is up, aliases like `builder@workshop`, the `teams.bundles@1` service a
// bundle registers its folder with, and the schemas of the `teams.*`
// commands, so the server plugin, the client and bundles read one contract.
import { z } from "@jhin/sdk";

import { AgentDefinition, AgentId, AgentStatus } from "./agents.ts";

/** The config section of teams (D682). */
export const TEAMS_CONFIG_SECTION = "jhin.teams";

/** The node's stream of team changes: specs, up and down (D689). */
export const TEAMS_STREAM = "teams";

/** The service a team bundle registers its folder with (D686). */
export const TEAM_BUNDLES_CAPABILITY = "teams.bundles";

/** Permissions of the `teams.*` commands (D690). */
export const TEAMS_READ_PERMISSION = "teams.read";
export const TEAMS_WRITE_PERMISSION = "teams.write";

/** Event types of the `teams` stream (D689). */
export const TeamEvents = {
  /** `{ teamId }`: a team appeared, changed or went (its config or its bundle). */
  changed: "teams.team.changed",
  /** `TeamRoster`: `teams.up` put the team's agents on their nodes. */
  up: "teams.team.up",
  /** `{ teamId, at }`: `teams.down` stopped the team's agents. */
  down: "teams.team.down",
} as const;

const SLUG = /^[a-z][a-z0-9-]{0,29}$/;
const SLUG_MESSAGE = "lowercase letters, digits and -, starting with a letter, at most 30";

/** A team's id (D681): part of its agents' ids and of their aliases. */
export const TeamId = z.string().regex(SLUG, SLUG_MESSAGE);
/** A member's name inside its team (`builder`, D683). */
export const MemberId = z.string().regex(SLUG, SLUG_MESSAGE);

/** The defined agent a member of a team is on its node: `<team>-<member>` (D683). */
export function teamAgentId(teamId: string, member: string): string {
  return AgentId.parse(`${TeamId.parse(teamId)}-${MemberId.parse(member)}`);
}

/** `builder@workshop`: a member's alias of its full address (D687). */
export const teamAlias = (teamId: string, member: string): string => `${member}@${teamId}`;

/** The member and team of an alias, or `undefined` when it is none. */
export function parseTeamAlias(
  alias: string,
): { readonly member: string; readonly teamId: string } | undefined {
  const match = /^([^@]+)@([^@]+)$/.exec(alias);
  if (match === null) return undefined;
  const [, member, teamId] = match;
  if (!SLUG.test(member!) || !SLUG.test(teamId!)) return undefined;
  return { member: member!, teamId: teamId! };
}

// Titles and descriptions are what the settings page shows (docs/plans/config-ui.md).
/** One member of a team (D681): an agent definition, and the node it runs on. */
export const TeamMember = AgentDefinition.extend({
  node: z.string().min(1).optional().meta({
    title: "Node",
    description: "The node its agent runs on, by node id; the node that runs teams.up when unset.",
  }),
});
export type TeamMember = z.output<typeof TeamMember>;

/** A team spec (D681): its agents, its lead, its culture and where its files are. */
export const TeamSpec = z
  .object({
    title: z.string().min(1).optional().meta({ title: "Title" }),
    description: z.string().optional().meta({ title: "Description" }),
    lead: MemberId.meta({
      title: "Lead",
      description: "The member the owner talks to; one of the team's agents.",
    }),
    culture: z.string().optional().meta({
      title: "Culture",
      description:
        "Markdown on how the team works together, told to every member; the culture.md of its files when unset.",
    }),
    project: z.string().min(1).optional().meta({
      title: "Home project",
      description: "The home project of members that name none: a project's id or path.",
    }),
    dir: z.string().min(1).optional().meta({
      title: "Files",
      description:
        "A folder with culture.md, lore/ and agents/<member>/ (starter knowledge): absolute, ~/…, or relative to the home project. A bundle's own folder when it comes from one.",
    }),
    agents: z
      .record(MemberId, TeamMember)
      .meta({ title: "Agents", description: "The team's members, by name." }),
  })
  .refine((spec) => spec.agents[spec.lead] !== undefined, {
    message: "the lead must be one of the team's agents",
    path: ["lead"],
  });
export type TeamSpec = z.output<typeof TeamSpec>;

/**
 * One config layer's entry of a team (D682): any part of a spec, merged over
 * the lower layers and a bundle's spec, key by key as config layers merge;
 * the merge is validated as a `TeamSpec`.
 */
export const TeamSpecLayer = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    lead: MemberId.optional(),
    culture: z.string().optional(),
    project: z.string().optional(),
    dir: z.string().optional(),
    agents: z.record(MemberId, TeamMember.partial()).optional(),
  })
  .meta({ title: "Team" });
export type TeamSpecLayer = z.output<typeof TeamSpecLayer>;

/** The `jhin.teams` section: teams by id (D682). */
export const TeamsConfig = z
  .object({
    teams: z.record(TeamId, TeamSpecLayer).default({}).meta({
      title: "Teams",
      description: "Teams of this node by id; an entry of a bundle's team changes that team.",
    }),
  })
  .meta({
    title: "Teams",
    description: "Teams of agents with a lead and a culture (docs/plans/agents.md, A5).",
  });
export type TeamsConfig = z.output<typeof TeamsConfig>;

/** A bundle's spec, `team.json` in its folder (D686): a spec with the team's id. */
export const TeamBundleSpec = TeamSpecLayer.extend({ id: TeamId });
export type TeamBundleSpec = z.output<typeof TeamBundleSpec>;

/** What `teams.bundles@1` serves (D686): bundles hand it their folder. */
export interface TeamBundles {
  /**
   * Registers the team of the bundle in `root` (its `team.json`, `culture.md`,
   * `lore/`, `agents/<member>/`) for the plugin `pluginId`; disposing it takes
   * the team away again. Throws when `team.json` is missing or invalid.
   */
  register(root: string, pluginId: string): { dispose(): void };
}

/**
 * A team that is up (D684, D687): who its members are and where. Every node
 * holding a member keeps it, so aliases resolve there.
 */
export const TeamRoster = z.object({
  teamId: TeamId,
  lead: MemberId,
  /** The node that ran `teams.up`, where the spec is. */
  nodeId: z.string(),
  /** Each member's full address, by name. */
  members: z.record(MemberId, z.string()),
  upAt: z.string(),
});
export type TeamRoster = z.output<typeof TeamRoster>;

/** One member as `teams.list` reports it. */
export const TeamMemberRecord = z.object({
  member: MemberId,
  alias: z.string(),
  agentId: z.string(),
  nodeId: z.string(),
  address: z.string(),
  role: z.string(),
  runtime: z.string(),
  model: z.string().optional(),
  lead: z.boolean(),
});
export type TeamMemberRecord = z.output<typeof TeamMemberRecord>;

/** A team as `teams.list` reports it (D689). */
export const TeamRecord = z.object({
  teamId: TeamId,
  title: z.string(),
  description: z.string().optional(),
  lead: z.string(),
  /** Where the spec comes from: config only, or a bundle (with `bundle`, its plugin id). */
  source: z.enum(["config", "bundle"]),
  bundle: z.string().optional(),
  culture: z.string().optional(),
  members: z.array(TeamMemberRecord),
  /** When it was last put up from this node; absent while it never was. */
  upAt: z.string().optional(),
  /** When it was last stopped from this node, after it was put up. */
  downAt: z.string().optional(),
  /** Why the merged spec is no valid team; `members` is then empty. */
  error: z.string().optional(),
});
export type TeamRecord = z.output<typeof TeamRecord>;

/** A Markdown file of a member's starter knowledge or of the team's lore (D685). */
export const TeamFile = z.object({
  /** Relative to the agent's knowledge folder: `<name>.md` or `lore/<name>.md`. */
  path: z.string().regex(/^(lore\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/),
  text: z.string(),
});
export type TeamFile = z.output<typeof TeamFile>;

/** Error codes of the `teams.*` commands. */
export type TeamErrorCode =
  /** No team with that id on this node. */
  | "TEAM_NOT_FOUND"
  /** The merged spec is no valid team; `details.error` says why. */
  | "TEAM_INVALID"
  /** The alias names a team this node has no roster of: it is not up here. */
  | "TEAM_NOT_UP"
  /** The alias names no member of its team. */
  | "MEMBER_NOT_FOUND"
  /** Not `<member>@<team>`. */
  | "ALIAS_INVALID"
  /** The member's agent id is defined on its node, not by this team. */
  | "AGENT_EXISTS"
  /** Another bundle registered a team of that id already. */
  | "TEAM_EXISTS";

const TeamRef = z.object({ teamId: TeamId });
/** What happened to one member's agent on `teams.up` or `teams.join`. */
const JoinResult = z.object({
  /** `defined` anew, `updated` to the spec, or `unchanged`. */
  result: z.enum(["defined", "updated", "unchanged"]),
  /** Whether it was stopped and is resumed now. */
  resumed: z.boolean(),
  /** The files written into its knowledge folder (only those missing there). */
  written: z.array(z.string()),
});
const MemberError = z.object({ code: z.string(), message: z.string() });

/** Input and output schemas of the `teams.*` commands (D684–D690). */
export const TeamCommands = {
  "teams.list": {
    input: z.object({}),
    /** Every team of this node, by id, and the head of the `teams` stream they reflect. */
    output: z.object({ head: z.number(), teams: z.array(TeamRecord) }),
  },
  "teams.get": {
    input: TeamRef,
    output: TeamRecord.extend({
      /** Each member's status on its node; `absent` while its agent is not defined there. */
      status: z.record(MemberId, z.union([AgentStatus, z.literal("absent")])),
    }),
  },
  "teams.up": {
    input: TeamRef,
    output: z.object({
      roster: TeamRoster,
      members: z.array(
        z.object({
          member: MemberId,
          address: z.string(),
          ...JoinResult.partial().shape,
          error: MemberError.optional(),
        }),
      ),
    }),
  },
  "teams.down": {
    input: TeamRef,
    output: z.object({
      members: z.array(
        z.object({
          member: MemberId,
          address: z.string(),
          stoppedAt: z.string().optional(),
          interrupted: z.boolean().optional(),
          error: MemberError.optional(),
        }),
      ),
    }),
  },
  "teams.join": {
    input: z.object({
      roster: TeamRoster,
      member: MemberId,
      /** The agent's definition, its team's part of the instructions included. */
      definition: AgentDefinition,
      files: z.array(TeamFile).default([]),
    }),
    output: JoinResult.extend({ address: z.string() }),
  },
  "teams.resolve": {
    input: z.object({ alias: z.string().min(1).meta({ description: "`<member>@<team>`" }) }),
    output: z.object({ address: z.string(), teamId: TeamId, member: MemberId }),
  },
} as const;
