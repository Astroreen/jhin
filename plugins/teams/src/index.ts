// Teams and team bundles (docs/plans/agents.md, A5: D681–D690). A team's
// members are defined agents of jhin.agents, reached through its commands
// here and through mesh.call on other nodes; this plugin keeps the specs,
// the rosters and the bundles' folders.
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  AGENT_OPTIONAL_FIELDS,
  TEAMS_CONFIG_SECTION,
  TEAMS_READ_PERMISSION,
  TEAMS_STREAM,
  TEAMS_WRITE_PERMISSION,
  TEAM_BUNDLES_CAPABILITY,
  TeamBundleSpec,
  TeamCommands,
  TeamEvents,
  TeamsConfig,
  agentAddress,
  ownerAddress,
  parseAgentAddress,
  parseTeamAlias,
  teamAgentId,
  teamAlias,
  type AgentDefinition,
  type AgentRecord,
  type AgentStatus,
  type TeamBundles,
  type TeamFile,
  type TeamMemberRecord,
  type TeamRecord,
  type TeamRoster,
  type TeamSpec,
  type TeamSpecLayer,
} from "@jhin/agent-api";
import { HOST_IDENTITY_CAPABILITY, type HostIdentity } from "@jhin/host-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import { definePlugin, describePermissions, type Invocation } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type Json,
  type KeyValueStore,
} from "@jhin/storage-api";

import { TeamsError } from "./errors.ts";
import { memberDefinition, readTeamFiles, resolveSpec } from "./spec.ts";

export {
  mergeLayers,
  memberDefinition,
  readTeamFiles,
  resolveSpec,
  teamInstructions,
} from "./spec.ts";

const NAMESPACE = "jhin.teams";
/** Changing teams puts agents on nodes, so it takes changing agents too (D690). */
const WRITE_PERMISSIONS = [TEAMS_WRITE_PERMISSION, "agents.write"];

interface Bundle {
  readonly spec: TeamSpecLayer;
  readonly root: string;
  readonly pluginId: string;
}

/** What this node keeps of an agent it put up for a team (D683). */
interface Seat {
  teamId: string;
  /** The definition last written, to tell `unchanged` from `updated`. */
  applied: AgentDefinition;
}

/** When the team was last put up and stopped from this node. */
interface TeamState {
  upAt?: string;
  downAt?: string;
}

interface ProjectInfo {
  readonly id: string;
  readonly path: string;
}

/** JSON with sorted keys, so two values compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expandHome(path: string): string {
  if (path === "~") return Os.homedir();
  return path.startsWith("~/") ? Path.join(Os.homedir(), path.slice(2)) : path;
}

const errorOf = (error: unknown) => ({
  code: String((error as { code?: unknown }).code ?? "FAILED"),
  message: error instanceof Error ? error.message : String(error),
});

export default definePlugin({
  async activate(context) {
    context.config.define(TEAMS_CONFIG_SECTION, TeamsConfig);
    const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const { nodeId } = context.services.get<HostIdentity>(HOST_IDENTITY_CAPABILITY);
    const now = () => new Date().toISOString();
    const run = <T>(name: string, input: unknown) =>
      context.commands.execute(name, input) as Promise<T>;
    const append = (type: string, payload: unknown) =>
      log.append(TEAMS_STREAM, [{ type, payload: payload as Json }]);

    // Following the stream takes what reading through the commands takes (security.md D415).
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    if (live?.guard !== undefined) {
      context.subscriptions.add(live.guard(TEAMS_STREAM, [TEAMS_READ_PERMISSION]));
    }
    describePermissions(context, {
      [TEAMS_READ_PERMISSION]: {
        title: "View teams",
        description: "Read teams, their members and their aliases.",
      },
      [TEAMS_WRITE_PERMISSION]: {
        title: "Manage teams",
        description: "Put teams up on their nodes and stop them.",
      },
    });

    // --- Specs: config over bundles (D682, D686) ----------------------------------
    const bundles = new Map<string, Bundle>();
    /** The last valid section: a broken file edit keeps the teams as they were. */
    let lastGood: TeamsConfig["teams"] = {};
    const configured = (): TeamsConfig["teams"] => {
      try {
        lastGood = context.config.get<TeamsConfig>(TEAMS_CONFIG_SECTION).teams;
      } catch (error) {
        context.log.warn("jhin.teams is invalid; keeping the teams as they were", {
          error: String(error),
        });
      }
      return lastGood;
    };
    const teamIds = () =>
      [...new Set([...Object.keys(configured()), ...bundles.keys()])].toSorted();
    const specOf = (teamId: string) => resolveSpec(bundles.get(teamId)?.spec, configured()[teamId]);

    /** Tells the stream which teams changed since it was last told (D689). */
    let told = new Map<string, string>();
    const snapshot = () =>
      new Map(teamIds().map((teamId) => [teamId, canonical(specOf(teamId))] as const));
    told = snapshot();
    let telling: Promise<unknown> = Promise.resolve();
    const tell = () => {
      telling = telling.then(async () => {
        const next = snapshot();
        const changed = [...new Set([...told.keys(), ...next.keys()])].filter(
          (teamId) => told.get(teamId) !== next.get(teamId),
        );
        told = next;
        for (const teamId of changed) await append(TeamEvents.changed, { teamId });
      });
      telling.catch((error: unknown) =>
        context.log.error("could not record a change of teams", { error: String(error) }),
      );
    };
    context.config.onDidChange(TEAMS_CONFIG_SECTION, tell);

    const service: TeamBundles = {
      register(root, pluginId) {
        const file = Path.join(root, "team.json");
        const spec = TeamBundleSpec.parse(JSON.parse(Fs.readFileSync(file, "utf8")));
        const taken = bundles.get(spec.id);
        if (taken !== undefined) {
          throw new TeamsError(
            "TEAM_EXISTS",
            `The team ${spec.id} comes from the bundle ${taken.pluginId} already`,
            { teamId: spec.id, bundle: taken.pluginId },
          );
        }
        const { id: teamId, ...layer } = spec;
        const bundle: Bundle = { spec: layer, root, pluginId };
        bundles.set(teamId, bundle);
        tell();
        return {
          dispose() {
            if (bundles.get(teamId) !== bundle) return;
            bundles.delete(teamId);
            tell();
          },
        };
      },
    };
    context.subscriptions.add(context.services.provide(TEAM_BUNDLES_CAPABILITY, service));

    /**
     * A home project named by the absolute path of a folder this node has no
     * project for is added, so the team that names it can work there (D1105).
     * A folder that does not exist fails as `projects.create` does; an id this
     * node does not know is left to the agent's status (`unavailable`, D608).
     */
    const ensureHome = async (project: string | undefined): Promise<void> => {
      if (project === undefined) return;
      const expanded = expandHome(project);
      if (!Path.isAbsolute(expanded)) return;
      const path = Path.resolve(expanded);
      const projects = await run<ProjectInfo[]>("projects.list", {});
      if (projects.some((item) => item.id === project || Path.resolve(item.path) === path)) return;
      await run("projects.create", { path });
    };

    /** The folder of a team's files: `dir` of the spec, else its bundle's (D686). */
    const filesDir = async (teamId: string, spec: TeamSpec): Promise<string | undefined> => {
      const configuredDir = configured()[teamId]?.dir;
      const bundle = bundles.get(teamId);
      if (configuredDir === undefined) return bundle?.root;
      const dir = expandHome(configuredDir);
      if (Path.isAbsolute(dir)) return dir;
      if (spec.project === undefined) return bundle?.root;
      const projects = await run<ProjectInfo[]>("projects.list", {});
      const wanted = Path.resolve(expandHome(spec.project));
      const home = projects.find(
        (project) => project.id === spec.project || Path.resolve(project.path) === wanted,
      );
      return home === undefined ? undefined : Path.join(home.path, dir);
    };

    const stateOf = async (teamId: string) =>
      ((await kv.get(NAMESPACE, `team/${teamId}`)) ?? {}) as TeamState;
    const rosterOf = async (teamId: string) =>
      (await kv.get(NAMESPACE, `roster/${teamId}`)) as TeamRoster | undefined;

    /** Each member's node and address, as `teams.up` puts them (D683, D685). */
    const rosterFor = (teamId: string, spec: TeamSpec): TeamRoster => ({
      teamId,
      lead: spec.lead,
      nodeId,
      members: Object.fromEntries(
        Object.entries(spec.agents).map(([member, definition]) => [
          member,
          agentAddress(definition.node ?? nodeId, teamAgentId(teamId, member)),
        ]),
      ),
      upAt: now(),
    });

    async function recordOf(teamId: string): Promise<TeamRecord> {
      const bundle = bundles.get(teamId);
      const resolved = specOf(teamId);
      const state = await stateOf(teamId);
      const base = {
        teamId,
        source: bundle === undefined ? ("config" as const) : ("bundle" as const),
        ...(bundle === undefined ? {} : { bundle: bundle.pluginId }),
        ...(state.upAt === undefined ? {} : { upAt: state.upAt }),
        ...(state.downAt === undefined ? {} : { downAt: state.downAt }),
      };
      if ("error" in resolved) {
        return { ...base, title: teamId, lead: "", members: [], error: resolved.error };
      }
      const { spec } = resolved;
      const roster = rosterFor(teamId, spec);
      const members: TeamMemberRecord[] = Object.entries(spec.agents).map(
        ([member, definition]) => ({
          member,
          alias: teamAlias(teamId, member),
          agentId: teamAgentId(teamId, member),
          nodeId: definition.node ?? nodeId,
          address: roster.members[member]!,
          role: definition.role,
          runtime: definition.runtime,
          ...(definition.model === undefined ? {} : { model: definition.model }),
          lead: member === spec.lead,
        }),
      );
      const culture =
        spec.culture ?? readTeamFiles(await filesDir(teamId, spec).catch(() => undefined)).culture;
      return {
        ...base,
        title: spec.title ?? teamId,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        lead: spec.lead,
        ...(culture === undefined ? {} : { culture }),
        members,
      };
    }

    const specOrThrow = (teamId: string): TeamSpec => {
      if (!teamIds().includes(teamId)) {
        throw new TeamsError("TEAM_NOT_FOUND", `No team ${teamId} on this node`, { teamId });
      }
      const resolved = specOf(teamId);
      if ("error" in resolved) {
        throw new TeamsError("TEAM_INVALID", `The team ${teamId} is invalid: ${resolved.error}`, {
          teamId,
          error: resolved.error,
        });
      }
      return resolved.spec;
    };

    /** Runs a command on another node with the grants it needs there (D416, D690). */
    const remote = <T>(
      node: string,
      method: string,
      params: unknown,
      invocation: Invocation,
      permissions: readonly string[],
    ) =>
      context.commands.execute(
        "mesh.call",
        { node, method, params },
        {
          ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
          caller: {
            id: invocation.caller?.id ?? context.plugin.id,
            permissions: ["mesh.call", ...permissions],
          },
        },
      ) as Promise<T>;

    // --- Joining: one member on this node (D683, D685) ------------------------------
    /** One join at a time, so a check and its write are one step. */
    let joining: Promise<unknown> = Promise.resolve();
    const serial = <T>(task: () => Promise<T>): Promise<T> => {
      const result = joining.then(task, task);
      joining = result.catch(() => undefined);
      return result;
    };

    const join = (input: {
      roster: TeamRoster;
      member: string;
      definition: AgentDefinition;
      files: TeamFile[];
    }) =>
      serial(async () => {
        const { roster, member, definition, files } = input;
        const agentId = teamAgentId(roster.teamId, member);
        const seat = (await kv.get(NAMESPACE, `seat/${agentId}`)) as Seat | undefined;
        const existing = await run<AgentRecord>("agents.get", { agentId }).catch(
          (error: unknown) => {
            if ((error as { code?: unknown }).code === "AGENT_NOT_FOUND") return undefined;
            throw error;
          },
        );
        if (
          existing !== undefined &&
          (existing.kind !== "defined" || seat?.teamId !== roster.teamId)
        ) {
          throw new TeamsError(
            "AGENT_EXISTS",
            `${agentId} is defined on node ${nodeId}, not by the team ${roster.teamId}`,
            { agentId, teamId: roster.teamId },
          );
        }
        await ensureHome(definition.project);
        let result: "defined" | "updated" | "unchanged";
        if (existing === undefined) {
          await run("agents.define", { agentId, ...definition });
          result = "defined";
        } else if (canonical(seat?.applied) === canonical(definition)) {
          result = "unchanged";
        } else {
          const unset = AGENT_OPTIONAL_FIELDS.filter((field) => definition[field] === undefined);
          await run("agents.update", { agentId, ...definition, unset });
          result = "updated";
        }
        await kv.set(NAMESPACE, `seat/${agentId}`, {
          teamId: roster.teamId,
          applied: definition,
        } as unknown as Json);
        await kv.set(NAMESPACE, `roster/${roster.teamId}`, roster as unknown as Json);

        const agent = await run<AgentRecord>("agents.get", { agentId });
        let resumed = false;
        if (agent.stoppedAt !== undefined) {
          resumed = (await run<{ resumed: boolean }>("agents.resume", { agentId })).resumed;
        }
        // Only what is missing: what the agent learnt is never overwritten (D685).
        const written: string[] = [];
        if (agent.knowledgeDir !== undefined) {
          for (const file of files) {
            const path = Path.join(agent.knowledgeDir, file.path);
            if (Fs.existsSync(path)) continue;
            Fs.mkdirSync(Path.dirname(path), { recursive: true });
            Fs.writeFileSync(path, file.text, { flag: "wx" });
            written.push(file.path);
          }
        }
        return { result, resumed, written, address: agentAddress(nodeId, agentId) };
      });

    // --- Commands (D684–D690) ------------------------------------------------------
    context.commands.register({
      name: "teams.list",
      description:
        "Every team of this node (its config and its bundles) with its lead, members, aliases and culture, and the head of the `teams` stream",
      ...TeamCommands["teams.list"],
      permissions: [TEAMS_READ_PERMISSION],
      handler: async () => {
        const head = await log.head(TEAMS_STREAM);
        return { head, teams: await Promise.all(teamIds().map(recordOf)) };
      },
    });

    context.commands.register({
      name: "teams.get",
      description: "A team of this node, with the status of each member's agent on its node",
      ...TeamCommands["teams.get"],
      permissions: [TEAMS_READ_PERMISSION],
      handler: async ({ teamId }, invocation) => {
        if (!teamIds().includes(teamId)) {
          throw new TeamsError("TEAM_NOT_FOUND", `No team ${teamId} on this node`, { teamId });
        }
        const record = await recordOf(teamId);
        const status: Record<string, AgentStatus | "absent"> = {};
        await Promise.all(
          record.members.map(async (member) => {
            const params = { agentId: member.agentId };
            try {
              const agent =
                member.nodeId === nodeId
                  ? await run<{ status: AgentStatus }>("agents.get", params)
                  : await remote<{ status: AgentStatus }>(
                      member.nodeId,
                      "agents.get",
                      params,
                      invocation,
                      ["agents.read"],
                    );
              status[member.member] = agent.status;
            } catch (error) {
              status[member.member] =
                (error as { code?: unknown }).code === "AGENT_NOT_FOUND" ? "absent" : "unavailable";
            }
          }),
        );
        return { ...record, status };
      },
    });

    context.commands.register({
      name: "teams.up",
      description:
        "Puts a team up: defines or updates each member's agent on its node (through the mesh for another node) with the team's instructions and files, and resumes stopped ones",
      ...TeamCommands["teams.up"],
      permissions: WRITE_PERMISSIONS,
      handler: async ({ teamId }, invocation) => {
        const spec = specOrThrow(teamId);
        // Its files may live in the home project (D686); a folder that is not
        // there fails each member's join below, with its reason.
        await ensureHome(spec.project).catch(() => undefined);
        const files = readTeamFiles(await filesDir(teamId, spec));
        const culture = spec.culture ?? files.culture;
        const roster = rosterFor(teamId, spec);
        const owner = ownerAddress(nodeId);
        const members = [];
        for (const member of Object.keys(spec.agents)) {
          const address = roster.members[member]!;
          const input = {
            roster,
            member,
            definition: memberDefinition({ spec, roster, member, owner, culture }),
            files: [...files.starter(member), ...files.lore],
          };
          const node = parseAgentAddress(address)!.nodeId;
          try {
            const joined =
              node === nodeId
                ? await join(input)
                : await remote<Awaited<ReturnType<typeof join>>>(
                    node,
                    "teams.join",
                    input,
                    invocation,
                    WRITE_PERMISSIONS,
                  );
            members.push({
              member,
              address,
              result: joined.result,
              resumed: joined.resumed,
              written: joined.written,
            });
          } catch (error) {
            members.push({ member, address, error: errorOf(error) });
          }
        }
        // This node resolves the aliases too, whether or not a member is on it (D687).
        await kv.set(NAMESPACE, `roster/${teamId}`, roster as unknown as Json);
        const state = await stateOf(teamId);
        await kv.set(NAMESPACE, `team/${teamId}`, { ...state, upAt: roster.upAt } as Json);
        await append(TeamEvents.up, roster);
        return { roster, members };
      },
    });

    context.commands.register({
      name: "teams.down",
      description:
        "Stops a team: stops each member's agent on its node (agents.stop); its definitions and roster stay, and teams.up resumes it",
      ...TeamCommands["teams.down"],
      permissions: WRITE_PERMISSIONS,
      handler: async ({ teamId }, invocation) => {
        const roster = (await rosterOf(teamId)) ?? rosterFor(teamId, specOrThrow(teamId));
        const members = [];
        for (const [member, address] of Object.entries(roster.members)) {
          const { nodeId: node, agentId } = parseAgentAddress(address)!;
          try {
            const stopped =
              node === nodeId
                ? await run<{ stoppedAt: string; interrupted: boolean }>("agents.stop", {
                    agentId,
                  })
                : await remote<{ stoppedAt: string; interrupted: boolean }>(
                    node,
                    "agents.stop",
                    { agentId },
                    invocation,
                    ["agents.write"],
                  );
            members.push({ member, address, ...stopped });
          } catch (error) {
            members.push({ member, address, error: errorOf(error) });
          }
        }
        const at = now();
        const state = await stateOf(teamId);
        await kv.set(NAMESPACE, `team/${teamId}`, { ...state, downAt: at } as Json);
        await append(TeamEvents.down, { teamId, at });
        return { members };
      },
    });

    context.commands.register({
      name: "teams.join",
      description:
        "Puts one member of a team on this node, as teams.up does for each: defines or updates its agent, resumes it, writes the team's files it lacks and keeps the roster",
      ...TeamCommands["teams.join"],
      permissions: WRITE_PERMISSIONS,
      handler: (input) => join(input),
    });

    context.commands.register({
      name: "teams.resolve",
      description:
        "The full address behind an alias `<member>@<team>` of a team that is up on this node",
      ...TeamCommands["teams.resolve"],
      permissions: [TEAMS_READ_PERMISSION],
      handler: async ({ alias }) => {
        const parsed = parseTeamAlias(alias);
        if (parsed === undefined) {
          throw new TeamsError("ALIAS_INVALID", `${alias} is not <member>@<team>`, { alias });
        }
        const roster = await rosterOf(parsed.teamId);
        if (roster === undefined) {
          throw new TeamsError("TEAM_NOT_UP", `The team ${parsed.teamId} is not up on this node`, {
            teamId: parsed.teamId,
          });
        }
        const address = roster.members[parsed.member];
        if (address === undefined) {
          throw new TeamsError(
            "MEMBER_NOT_FOUND",
            `The team ${parsed.teamId} has no member ${parsed.member}`,
            { teamId: parsed.teamId, member: parsed.member },
          );
        }
        return { address, ...parsed };
      },
    });
  },
});
