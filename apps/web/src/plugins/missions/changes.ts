// What an edit dialog sends (docs/plans/agents.md, C2: D1083–D1085): only the
// fields the owner changed, so the command checks only what is new.
import {
  DEFAULT_MISSION_PROCESS,
  SLICE_STATUSES,
  type Mission,
  type MissionStatus,
  type ProjectIntent,
  type Slice,
  type SliceStatus,
} from "@jhin/missions-api";

import { parseSteps, sameSteps } from "./route.ts";

/** `missions.intent.set`'s fields that changed; with no record yet, both. */
export function intentChanges(
  previous: ProjectIntent | undefined,
  form: {
    readonly intent: string;
    readonly process: string;
    readonly descriptions?: Readonly<Record<string, string>>;
  },
): { intent?: string; process?: ProjectIntent["process"] } {
  const process = parseSteps(form.process, previous?.process, form.descriptions);
  return {
    ...(previous !== undefined && form.intent === previous.intent ? {} : { intent: form.intent }),
    ...(previous !== undefined && sameSteps(process, previous.process) ? {} : { process }),
  };
}

/**
 * A new mission's process from the dialog's text: a step the default process
 * has keeps its fields there, so the default `merge` still needs a review
 * (D648, D1241; L3 D1264).
 */
export function newMissionProcess(form: {
  readonly sliceProcess: string;
  readonly missionProcess: string;
  /** Descriptions the owner typed, by step id (D1388). */
  readonly sliceDescriptions?: Readonly<Record<string, string>>;
  readonly missionDescriptions?: Readonly<Record<string, string>>;
}): Mission["process"] {
  return {
    slice: parseSteps(form.sliceProcess, DEFAULT_MISSION_PROCESS.slice, form.sliceDescriptions),
    mission: parseSteps(
      form.missionProcess,
      DEFAULT_MISSION_PROCESS.mission,
      form.missionDescriptions,
    ),
  };
}

/** `missions.update`'s fields that changed. */
export function missionChanges(
  mission: Mission,
  form: {
    readonly title: string;
    readonly outcome: string;
    readonly status: MissionStatus;
    readonly sliceProcess: string;
    readonly missionProcess: string;
    /** Step descriptions the owner typed, by step id (D1388). */
    readonly sliceDescriptions?: Readonly<Record<string, string>>;
    readonly missionDescriptions?: Readonly<Record<string, string>>;
  },
) {
  const process = {
    slice: parseSteps(form.sliceProcess, mission.process.slice, form.sliceDescriptions),
    mission: parseSteps(form.missionProcess, mission.process.mission, form.missionDescriptions),
  };
  const sameProcess =
    sameSteps(process.slice, mission.process.slice) &&
    sameSteps(process.mission, mission.process.mission);
  return {
    ...(form.title === mission.title ? {} : { title: form.title }),
    ...(form.outcome === mission.outcome ? {} : { outcome: form.outcome }),
    ...(form.status === mission.status ? {} : { status: form.status }),
    ...(sameProcess ? {} : { process }),
  };
}

/** `slices.update`'s fields that changed; `null` clears an assignee or a step. */
export function sliceChanges(
  slice: Slice,
  form: {
    readonly title: string;
    readonly spec: string;
    readonly assignee: string | undefined;
    readonly wave: number;
    readonly dependsOn: readonly string[];
    readonly status: SliceStatus;
    readonly step: string | undefined;
  },
) {
  const sameDependencies =
    form.dependsOn.length === slice.dependsOn.length &&
    form.dependsOn.every((id) => slice.dependsOn.includes(id));
  return {
    ...(form.title === slice.title ? {} : { title: form.title }),
    ...(form.spec === slice.spec ? {} : { spec: form.spec }),
    ...(form.assignee === slice.assignee ? {} : { assignee: form.assignee ?? null }),
    ...(form.wave === slice.wave ? {} : { wave: form.wave }),
    ...(sameDependencies ? {} : { dependsOn: [...form.dependsOn] }),
    ...(form.status === slice.status ? {} : { status: form.status }),
    ...(form.step === slice.step ? {} : { step: form.step ?? null }),
  };
}

/**
 * The statuses a slice can be given here (D1085): Done only when it is done
 * already (a proof makes it done, D646), Dropped only for a slice that exists.
 */
export const sliceStatusOptions = (slice: Slice | undefined): SliceStatus[] =>
  SLICE_STATUSES.filter((value) =>
    value === "done" ? slice?.status === "done" : slice !== undefined || value !== "dropped",
  );
