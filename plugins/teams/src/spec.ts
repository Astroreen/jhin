// What a team spec becomes (docs/plans/agents.md, A5: D682, D684, D685): the
// merge of its layers, the files of its folder, and each member's definition.
import * as Fs from "node:fs";
import * as Path from "node:path";

import {
  TeamFile,
  TeamSpec,
  teamAlias,
  type AgentDefinition,
  type TeamRoster,
  type TeamSpecLayer,
} from "@jhin/agent-api";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Objects merge key by key; everything else (arrays included) is replaced, as config layers merge (D682). */
export function mergeLayers(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!UNSAFE_KEYS.has(key)) result[key] = mergeLayers(base[key], value);
  }
  return result;
}

/** The merged spec of a team, or why it is none. */
export function resolveSpec(
  bundle: TeamSpecLayer | undefined,
  config: TeamSpecLayer | undefined,
): { spec: TeamSpec } | { error: string } {
  const parsed = TeamSpec.safeParse(mergeLayers(bundle ?? {}, config ?? {}));
  if (parsed.success) return { spec: parsed.data };
  return {
    error: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
      .join("; "),
  };
}

/** The Markdown files directly in `dir` that a `TeamFile` may name, by name. */
function markdownIn(dir: string): { name: string; text: string }[] {
  let names: string[];
  try {
    names = Fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!TeamFile.shape.path.safeParse(name).success) return [];
    try {
      return [{ name, text: Fs.readFileSync(Path.join(dir, name), "utf8") }];
    } catch {
      return [];
    }
  });
}

/** What a team's folder holds (D685, D686): its culture, lore and each member's starter knowledge. */
export function readTeamFiles(dir: string | undefined): {
  culture?: string;
  lore: TeamFile[];
  starter: (member: string) => TeamFile[];
} {
  if (dir === undefined) return { lore: [], starter: () => [] };
  let culture: string | undefined;
  try {
    culture = Fs.readFileSync(Path.join(dir, "culture.md"), "utf8");
  } catch {
    culture = undefined;
  }
  const lore = markdownIn(Path.join(dir, "lore")).map(({ name, text }) => ({
    path: `lore/${name}`,
    text,
  }));
  return {
    ...(culture === undefined ? {} : { culture }),
    lore,
    starter: (member) =>
      markdownIn(Path.join(dir, "agents", member)).map(({ name, text }) => ({ path: name, text })),
  };
}

/** The team's part of a member's instructions (D684, D688). */
export function teamInstructions(options: {
  readonly spec: TeamSpec;
  readonly roster: TeamRoster;
  readonly member: string;
  readonly owner: string;
  readonly culture?: string | undefined;
}): string {
  const { spec, roster, member, owner } = options;
  const teamId = roster.teamId;
  const title = spec.title ?? teamId;
  const lead = teamAlias(teamId, spec.lead);
  const members = Object.entries(spec.agents).map(
    ([name, definition]) =>
      `- ${teamAlias(teamId, name)} (${roster.members[name]}): ${definition.role}${name === spec.lead ? " (the lead)" : ""}${name === member ? " (you)" : ""}`,
  );
  const escalation =
    member === spec.lead
      ? [
          "You lead the team, and the owner talks to you. Hand work to your teammates with agents_send and ask them with agents_ask, by alias or address.",
          "Ask other teams' leads (teams_list names them) before you ask the owner.",
          `A decision only the owner can take goes to the owner with agents_ask to ${owner}: it waits in their inbox, and their answer comes back to you as a message. Say what you decided without them and why, so they judge with the context.`,
        ]
      : [
          `Your lead is ${lead}. Ask the teammate who knows, or your lead, with agents_ask; do not ask the owner: your lead does.`,
        ];
  const culture = options.culture?.trim();
  return [
    `You are ${teamAlias(teamId, member)}, a member of the team ${title}${spec.description === undefined ? "" : `: ${spec.description}`}.`,
    "The team:",
    ...members,
    "",
    ...escalation,
    ...(culture === undefined || culture === "" ? [] : ["", "How the team works:", "", culture]),
  ].join("\n");
}

/** A member's agent definition (D684): the spec's member, its home project and its instructions. */
export function memberDefinition(options: {
  readonly spec: TeamSpec;
  readonly roster: TeamRoster;
  readonly member: string;
  readonly owner: string;
  readonly culture?: string | undefined;
}): AgentDefinition {
  const { node: _node, project, instructions, ...rest } = options.spec.agents[options.member]!;
  const home = project ?? options.spec.project;
  const own = instructions?.trim();
  return {
    ...rest,
    ...(home === undefined ? {} : { project: home }),
    instructions: [
      teamInstructions(options),
      ...(own === undefined || own === "" ? [] : ["", own]),
    ].join("\n"),
  };
}
