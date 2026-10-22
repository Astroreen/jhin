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
