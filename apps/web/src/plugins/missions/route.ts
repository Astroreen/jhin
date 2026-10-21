import type { NodeTarget, Route } from "@jhin/client-api";
import type { MissionStatus, SliceStatus, SliceThread } from "@jhin/missions-api";

/** The route panels the mission view owns in `civilization.views` (D653). */
const MISSION_PANEL = "mission";
const SLICE_PANEL = "slice";

/** Where the mission view is: a mission, a slice, or a thread working on a slice. */
export type MissionPlace =
  | { readonly kind: "mission"; readonly missionId: string }
  | { readonly kind: "slice"; readonly sliceId: string; readonly thread?: SliceThread };

/**
 * The route's place in the mission view, if it shows one (D653): `p=mission`
 * with the mission id as section, `p=slice` with `<sliceId>`, or
 * `<sliceId>/<threadId>` and `<sliceId>/<threadId>@<nodeId>` for a thread of
 * the slice. Ids are UUIDs, so neither `/` nor `@` occurs in them.
 */
export function placeOf(route: Route): MissionPlace | undefined {
  if (route.section === undefined || route.section === "") return undefined;
  if (route.panel === MISSION_PANEL) return { kind: "mission", missionId: route.section };
  if (route.panel !== SLICE_PANEL) return undefined;
  const [sliceId = "", thread] = route.section.split("/", 2);
  if (sliceId === "") return undefined;
  if (thread === undefined || thread === "") return { kind: "slice", sliceId };
  const [threadId = "", nodeId] = thread.split("@", 2);
  if (threadId === "") return { kind: "slice", sliceId };
  return {
    kind: "slice",
    sliceId,
    thread: nodeId === undefined || nodeId === "" ? { threadId } : { threadId, nodeId },
  };
}

/** The route of a place, on the route's node and in its mode. */
export function routeOf(route: Route, place: MissionPlace): Route {
  const base: Route = {
    ...(route.node === undefined ? {} : { node: route.node }),
    ...(route.remote === undefined ? {} : { remote: route.remote }),
    ...(route.mode === undefined ? {} : { mode: route.mode }),
  };
  if (place.kind === "mission") {
    return { ...base, panel: MISSION_PANEL, section: place.missionId };
  }
  const thread =
    place.thread === undefined
      ? ""
      : `/${place.thread.threadId}${place.thread.nodeId === undefined ? "" : `@${place.thread.nodeId}`}`;
  return { ...base, panel: SLICE_PANEL, section: `${place.sliceId}${thread}` };
}

/**
 * Where to read a slice's thread from (D647): on the route's node when the
 * thread names none or names that node itself, else through its mesh.
 */
export function threadTarget(
  route: NodeTarget,
  thread: SliceThread,
  selfNodeId: string | undefined,
): NodeTarget {
  if (thread.nodeId === undefined || thread.nodeId === (route.remote ?? selfNodeId)) return route;
  return { node: route.node, remote: thread.nodeId };
}

/** Whether two slice threads are the same thread. */
export const sameThread = (a: SliceThread, b: SliceThread): boolean =>
  a.threadId === b.threadId && (a.nodeId ?? "") === (b.nodeId ?? "");

/** An assignee address (D645) as people read it: the agent's id, or "Owner". */
export function assigneeLabel(assignee: string | undefined): string {
  if (assignee === undefined) return "Unassigned";
  const match = /^jhin:\/\/([^/]+)\/(?:agents\/([^/]+)|owner)$/.exec(assignee);
  if (match === null) return assignee;
  return match[2] === undefined ? "Owner" : match[2];
}

export const STATUS_LABELS: Readonly<Record<MissionStatus | SliceStatus, string>> = {
  planned: "Planned",
  active: "Active",
  blocked: "Blocked",
  done: "Done",
  dropped: "Dropped",
};

/** The badge variant of a status, in T3's colours: active info, blocked warning, done success. */
export function statusVariant(
  status: MissionStatus | SliceStatus,
): "info" | "warning" | "success" | "secondary" | "outline" {
  switch (status) {
    case "active":
      return "info";
    case "blocked":
      return "warning";
    case "done":
      return "success";
    case "dropped":
      return "outline";
    default:
      return "secondary";
  }
}

/** Open missions first (active, then planned), closed ones after; oldest first within. */
export function missionRank(status: MissionStatus): number {
  return { active: 0, planned: 1, done: 2, dropped: 3 }[status];
}
