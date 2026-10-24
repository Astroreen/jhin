import type { NodeTarget, Route } from "@jhin/client-api";
import { targetFields } from "../../lib/mesh-targets.ts";
import { CIVILIZATION_MODE } from "../../lib/modes.ts";

/** The route panel of an agent's page (D615). */
export const AGENT_PANEL = "agent";

/**
 * An agent's page (D615): panel `agent`, the agent and the generation shown in
 * `section` (`<agentId>` for the current one, `<agentId>/<n>` for another).
 * Never `thread`: a generation is not one of Threads mode's threads.
 */
export function agentRoute(target: NodeTarget, agentId: string, generation?: number): Route {
  return {
    ...targetFields(target),
    mode: CIVILIZATION_MODE,
    panel: AGENT_PANEL,
    section: generation === undefined ? agentId : `${agentId}/${generation}`,
  };
}

/** The agent and generation of an agent page's `section`, or `undefined` for anything else. */
export function parseAgentSection(
  section: string | undefined,
): { readonly agentId: string; readonly generation?: number } | undefined {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/([1-9][0-9]*))?$/.exec(section ?? "");
  if (match === null) return undefined;
  return match[2] === undefined
    ? { agentId: match[1]! }
    : { agentId: match[1]!, generation: Number(match[2]) };
}

/** The route panel of the form that defines or edits an agent (D1065). */
export const AGENT_FORM_PANEL = "agent-definition";

/** The form of a new agent, or with `agentId` of one to edit (D1065), on its node (D1528). */
export function agentFormRoute(target: NodeTarget, agentId?: string): Route {
  return {
    ...targetFields(target),
    mode: CIVILIZATION_MODE,
    panel: AGENT_FORM_PANEL,
    ...(agentId === undefined ? {} : { section: agentId }),
  };
}
