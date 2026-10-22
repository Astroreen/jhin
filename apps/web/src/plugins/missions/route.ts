import type { NodeTarget, Route } from "@jhin/client-api";
import type {
  Mission,
  MissionStatus,
  Slice,
  SliceStatus,
  SliceThread,
  Step,
} from "@jhin/missions-api";

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

/**
 * An assignee address (D645) as people read it: the agent's title when its
 * node lists it (`titles`, by address, D1082), else its id, or "Owner".
 */
export function assigneeLabel(
  assignee: string | undefined,
  titles: ReadonlyMap<string, string> = new Map(),
): string {
  if (assignee === undefined) return "Unassigned";
  const title = titles.get(assignee);
  if (title !== undefined) return title;
  const match = /^jhin:\/\/([^/]+)\/(?:agents\/([^/]+)|owner)$/.exec(assignee);
  if (match === null) return assignee;
  return match[2] === undefined ? "Owner" : match[2];
}

/** A process as one line the owner edits: its step ids in order (D1084). */
export const formatSteps = (steps: readonly Step[]): string =>
  steps.map((step) => step.id).join(" → ");

/**
 * The steps of an edited line: ids split at arrows, commas and spaces, each
 * keeping the description it had (D1084). The command checks the ids.
 */
export function parseSteps(text: string, previous: readonly Step[] = []): Step[] {
  const described = new Map(previous.map((step) => [step.id, step]));
  return text
    .split(/(?:->|→|,|\s)+/u)
    .filter((id) => id !== "")
    .map((id) => described.get(id) ?? { id });
}

/** Whether two processes have the same steps in the same order. */
export const sameSteps = (a: readonly Step[], b: readonly Step[]): boolean =>
  a.length === b.length && a.every((step, index) => step.id === b[index]?.id);

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

/** Beside a mission (D1087): the orchestrator's panel, and whatever else a plugin puts there. */
export const MISSION_ASIDE_SLOT = "civilization.mission.aside";

/** What a contribution beside a mission is given: the mission as the view folds it. */
export interface MissionAsideProps {
  /** The view's node, and the connection it is reached through. */
  readonly target: NodeTarget;
  readonly mission: Mission;
  readonly slices: readonly Slice[];
  /** The node's id, for `missionProgress` (D702); undefined until known. */
  readonly nodeId: string | undefined;
  /** Assignee titles by address (D1082). */
  readonly titles: ReadonlyMap<string, string>;
}

/** A mission's orchestrator run as `missions.orchestration` and the `orchestration` stream carry it (D1086). */
export interface OrchestratorRun {
  readonly workflowId: string;
  readonly parentThreadId: string;
  readonly status: string;
  readonly currentPhase?: string;
  readonly logs: readonly string[];
  readonly result?: unknown;
  readonly error?: string;
  readonly updatedAt: string;
}

/** The run's state as the owner reads it (D1088): a stopped run is paused, a finished one waits for the lead. */
export function runLabel(run: OrchestratorRun | null | undefined): string {
  if (run === null || run === undefined) return "Not running";
  switch (run.status) {
    case "running":
      return "Running";
    case "stopped":
      return "Paused";
    case "completed":
      return "Waiting for the lead";
    case "failed":
      return "Failed";
    default:
      return run.status;
  }
}

const REASONS: Readonly<Record<string, string>> = {
  unassigned: "no assignee",
  blocked: "blocked",
  orphaned: "a dependency was dropped",
  elsewhere: "assignee on another node",
  "handoff-failed": "handoff failed",
};

interface RunResult {
  readonly outcome?: string;
  readonly wave?: number;
  readonly steps?: readonly { id: string }[];
  readonly projectSteps?: readonly { id: string }[];
  readonly decisions?: readonly { sliceId: string; reason: string }[];
  readonly note?: string;
}

const stepList = (steps: readonly { id: string }[] | undefined) =>
  steps === undefined || steps.length === 0
    ? "its steps"
    : steps.map((step) => step.id).join(" → ");

/**
 * What a mission's run waits for (D1088), from the run and where the mission
 * is (`missionProgress`, D702): the proofs of its working slices while it runs,
 * the lead once it ended with an outcome (D707), the owner while paused.
 */
export function waitsFor(
  run: OrchestratorRun | null | undefined,
  progress: { readonly ready: readonly string[]; readonly working: readonly string[] },
  titleOf: (sliceId: string) => string,
): string {
  const titles = (ids: readonly string[]) => ids.map(titleOf).join(", ");
  if (run === null || run === undefined) return "Nothing runs this mission.";
  switch (run.status) {
    case "running":
      if (progress.ready.length > 0) return `Handing off ${titles(progress.ready)}.`;
      if (progress.working.length > 0) return `The proof of ${titles(progress.working)}.`;
      return "The mission to move.";
    case "stopped":
      return "The owner: paused. Handed slices go on; resume to hand off the next ones.";
    case "failed":
      return `The owner: the run failed${run.error === undefined ? "." : `: ${run.error}`}`;
    case "completed": {
      const result = (run.result ?? {}) as RunResult;
      switch (result.outcome) {
        case "decide": {
          const decisions = result.decisions ?? [];
          if (decisions.length === 0) return `The lead's decision: ${result.note ?? "plan slices"}`;
          return `The lead's decision on ${decisions
            .map((item) => `${titleOf(item.sliceId)} (${REASONS[item.reason] ?? item.reason})`)
            .join(", ")}.`;
        }
        case "wave-done":
          return `The lead: run ${stepList(result.steps)} after wave ${result.wave ?? "?"}, then orchestrate again.`;
        case "slices-done":
          return `The lead: run ${stepList([...(result.steps ?? []), ...(result.projectSteps ?? [])])}, then set the mission done.`;
        case "closed":
          return "Nothing: the mission is closed.";
        default:
          return "The lead.";
      }
    }
    default:
      return "The lead.";
  }
}
