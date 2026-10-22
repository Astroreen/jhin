import type { HealthGroup, Warning } from "@jhin/health-api";
import type { Route } from "@jhin/client-api";
import { CIVILIZATION_MODE } from "../../lib/modes.ts";

/** The route panel of health (agents.md D731). */
export const HEALTH_PANEL = "health";

/** Health's page: panel `health`; a warning's id as `section`, none for the overview. */
export function healthRoute(node: string, warningId?: string): Route {
  return {
    node,
    mode: CIVILIZATION_MODE,
    panel: HEALTH_PANEL,
    ...(warningId === undefined ? {} : { section: warningId }),
  };
}

/** A short id: the first 8 characters of a long one. */
const short = (id: string) => (id.length > 12 ? id.slice(0, 8) : id);

/** What a group is, in a few words. */
export function groupLabel(group: HealthGroup): string {
  switch (group.kind) {
    case "node":
      return "The node";
    case "project":
      return `Project ${short(group.projectId)}`;
    case "mission":
      return `Mission ${group.title ?? short(group.missionId)}`;
    case "team":
      return `Team ${group.teamId}`;
  }
}

/** What a detector found, as a heading. */
export function detectorLabel(warning: Pick<Warning, "detector">): string {
  switch (warning.detector) {
    case "ceremony":
      return "Ceremony outgrows progress";
    case "proof-loop":
      return "Recursive proof loop";
    case "mind-virus":
      return "Mind virus";
  }
}
