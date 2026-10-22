// What an edit dialog sends (docs/plans/agents.md, C2: D1083–D1085): only the
// fields the owner changed, so the command checks only what is new.
import {
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
  form: { readonly intent: string; readonly process: string },
): { intent?: string; process?: ProjectIntent["process"] } {
  const process = parseSteps(form.process, previous?.process);
  return {
    ...(previous !== undefined && form.intent === previous.intent ? {} : { intent: form.intent }),
    ...(previous !== undefined && sameSteps(process, previous.process) ? {} : { process }),
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
  },
) {
  const process = {
    slice: parseSteps(form.sliceProcess, mission.process.slice),
    mission: parseSteps(form.missionProcess, mission.process.mission),
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
