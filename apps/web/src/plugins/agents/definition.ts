// An agent's definition as the owner edits it in Civilization mode
// (docs/plans/agents.md, C1: D1065): what the form holds, and the
// `agents.define` or `agents.update` input it makes.
import { AGENT_OPTIONAL_FIELDS, AgentId, type AgentRecord } from "@jhin/agent-api";

/** The form's fields, as typed: an empty one is unset. */
export interface AgentDraft {
  readonly agentId: string;
  readonly title: string;
  readonly role: string;
  readonly runtime: string;
  readonly model: string;
  /** Skill names, separated by commas or line breaks. */
  readonly skills: string;
  readonly instructions: string;
  /** A project's id; empty for the scratch project. */
  readonly project: string;
  /** Whether its runtime loads the node user's own settings (D1561); off when unset. */
  readonly userSettings: boolean;
}

type OptionalField = (typeof AGENT_OPTIONAL_FIELDS)[number];

/** The draft of an agent being edited, or of a new one. */
export function draftOf(agent?: AgentRecord): AgentDraft {
  return {
    agentId: agent?.agentId ?? "",
    // A title equal to the id is the id shown, not one that was set.
    title: agent === undefined || agent.title === agent.agentId ? "" : agent.title,
    role: agent?.role ?? "",
    runtime: agent?.runtimeId ?? "",
    model: agent?.model ?? "",
    skills: agent?.skills.join(", ") ?? "",
    instructions: agent?.instructions ?? "",
    project: agent?.projectId ?? "",
    userSettings: agent?.userSettings === true,
  };
}

const skillsOf = (text: string) =>
  text
    .split(/[,\n]/)
    .map((skill) => skill.trim())
    .filter((skill) => skill !== "");

/** What keeps the draft from being saved, said for the owner; `undefined` when nothing does. */
export function draftProblem(draft: AgentDraft, isNew: boolean): string | undefined {
  if (isNew && !AgentId.safeParse(draft.agentId.trim()).success) {
    return "The id takes lowercase letters, digits and -, starting with a letter.";
  }
  if (draft.role.trim() === "") return "Say what the agent does: its role.";
  if (draft.runtime === "") return "Choose the runtime that runs its turns.";
  return undefined;
}

/** The fields of a draft that are set, as a definition has them. */
function fieldsOf(draft: AgentDraft) {
  const skills = skillsOf(draft.skills);
  const text = (value: string) => (value.trim() === "" ? undefined : value.trim());
  return {
    role: draft.role.trim(),
    runtime: draft.runtime,
    title: text(draft.title),
    model: text(draft.model),
    instructions: draft.instructions.trim() === "" ? undefined : draft.instructions,
    skills: skills.length === 0 ? undefined : skills,
    project: text(draft.project),
    userSettings: draft.userSettings ? true : undefined,
  };
}

const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** The input of `agents.define` for a new agent. */
export function defineInput(draft: AgentDraft) {
  return { agentId: draft.agentId.trim(), ...defined(fieldsOf(draft)) };
}

/**
 * The input of `agents.update` for what the draft changed of `agent`: changed
 * fields are set, emptied ones are `unset`; `undefined` when nothing changed.
 */
export function updateInput(agent: AgentRecord, draft: AgentDraft) {
  const before = fieldsOf(draftOf(agent));
  const after = fieldsOf(draft);
  const set: Record<string, unknown> = {};
  const unset: OptionalField[] = [];
  for (const key of Object.keys(after) as (keyof typeof after)[]) {
    const was = JSON.stringify(before[key]);
    const is = JSON.stringify(after[key]);
    if (was === is) continue;
    if (after[key] === undefined) unset.push(key as OptionalField);
    else set[key] = after[key];
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return undefined;
  return { agentId: agent.agentId, ...set, ...(unset.length === 0 ? {} : { unset }) };
}
