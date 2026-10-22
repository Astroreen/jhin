import type { AgentStatus, TeamRecord } from "@jhin/agent-api";
import type { Route } from "@jhin/client-api";

/** The route panel of a team's page in `civilization.views`, the team id as section (D691). */
export const TEAM_PANEL = "team";

/** A team's page, on the route's node and in its mode. */
export function teamRoute(route: Route, teamId: string): Route {
  return {
    ...(route.node === undefined ? {} : { node: route.node }),
    ...(route.remote === undefined ? {} : { remote: route.remote }),
    ...(route.mode === undefined ? {} : { mode: route.mode }),
    panel: TEAM_PANEL,
    section: teamId,
  };
}

/** The Lead view talking to a team's lead: no panel, the team id as section (D1062). */
export function leadRoute(route: Route, teamId?: string): Route {
  return {
    ...(route.node === undefined ? {} : { node: route.node }),
    ...(route.remote === undefined ? {} : { remote: route.remote }),
    ...(route.mode === undefined ? {} : { mode: route.mode }),
    ...(teamId === undefined ? {} : { section: teamId }),
  };
}

/** The team the Lead view talks to: the route's, else the first one up, else the first (D1062). */
export function chosenTeam(
  teams: readonly TeamRecord[],
  route: Pick<Route, "panel" | "section">,
): TeamRecord | undefined {
  const valid = teams.filter((team) => team.error === undefined);
  if (route.panel === undefined && route.section !== undefined) {
    const named = valid.find((team) => team.teamId === route.section);
    if (named !== undefined) return named;
  }
  return valid.find((team) => isUp(team)) ?? valid[0];
}

/** Whether a team is up: put up from this node, and not stopped since (D689). */
export function isUp(team: Pick<TeamRecord, "upAt" | "downAt">): boolean {
  if (team.upAt === undefined) return false;
  return team.downAt === undefined || team.downAt < team.upAt;
}

export const STATUS_LABELS: Readonly<Record<AgentStatus | "absent", string>> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for you",
  stopped: "Stopped",
  unavailable: "Unavailable",
  absent: "Not up",
};

/** The badge variant of a member's status, in T3's colours. */
export function statusVariant(
  status: AgentStatus | "absent",
): "info" | "warning" | "success" | "secondary" | "outline" | "error" {
  switch (status) {
    case "working":
      return "info";
    case "waiting":
      return "warning";
    case "idle":
      return "success";
    case "unavailable":
      return "error";
    case "absent":
      return "outline";
    default:
      return "secondary";
  }
}

/** A node id as people read it: a long one cut to its first 8 characters. */
export const nodeLabel = (nodeId: string) => (nodeId.length > 12 ? nodeId.slice(0, 8) : nodeId);
