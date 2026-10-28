import * as Crypto from "node:crypto";

import {
  Assignee,
  DEFAULT_MISSION_PROCESS,
  EMPTY_MISSIONS,
  IntentChain,
  MISSIONS_STREAM,
  MISSION_DELETE_HOOK,
  MISSION_EVENT_RECORD,
  MISSION_STEP_HOOK,
  Mission,
  MissionEvents,
  MissionProcess,
  MissionStatus,
  ProjectIntent,
  ProofItems,
  ReviewVerdict,
  Slice,
  SliceStatus,
  SliceThread,
  Steps,
  applyMissionEvent,
  intentChain,
  missionsOf,
  onMissionNode,
  renderMarkdown,
  slicesOf,
  type MissionErrorCode,
  type MissionEventType,
  type MissionsState,
  REVIEW_TREE_EXCLUDE,
  type ReviewedWork,
  recordedBy,
} from "@jhin/missions-api";
import { HOST_IDENTITY_CAPABILITY, type HostIdentity } from "@jhin/host-api";
import { MESH_STREAMS_CAPABILITY, type MeshStreams } from "@jhin/mesh-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import {
  definePlugin,
  z,
  type CommandDefinition,
  type Invocation,
  describePermissions,
} from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  StorageError,
  type EventLog,
  type Json,
  type StoredEvent,
} from "@jhin/storage-api";

export { MISSIONS_STREAM };

/** How often a change is tried again when another writer appended to the stream meanwhile. */
const MAX_ATTEMPTS = 5;

/** Two records with the same fields, whatever their key order. */
function same(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, field]) => field !== undefined)
              .toSorted(([x], [y]) => x.localeCompare(y))
              .map(([key, field]) => [key, canonical(field)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

class MissionsError extends Error {
  readonly code: MissionErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MissionErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const Title = z.string().trim().min(1).max(200);
const Text = z.string().max(20_000);
const ProjectIntentView = ProjectIntent.partial({ updatedAt: true });

export default definePlugin({
  async activate(context) {
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const now = () => new Date().toISOString();
    // Following the stream takes what reading through the commands takes (security.md D415).
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    if (live?.guard !== undefined) {
      context.subscriptions.add(live.guard(MISSIONS_STREAM, ["missions.read"]));
    }
    // Members read it through relays, within their grants and that guard (M1, D1521).
    const shared = context.services.tryGet<MeshStreams>(MESH_STREAMS_CAPABILITY);
    // Never shared without its guard.
    if (shared !== undefined && live?.guard !== undefined) {
      context.subscriptions.add(shared.share(MISSIONS_STREAM));
    }

    // --- State: the fold of the stream ------------------------------------------
    let state: MissionsState = EMPTY_MISSIONS;
    let head = 0;
    const apply = (events: readonly StoredEvent[]) => {
      for (const event of events) {
        // Two catch-ups running at once never apply an event twice.
        if (event.sequence <= head) continue;
        state = applyMissionEvent(state, event);
        head = event.sequence;
      }
    };
    /** Catches up with what was appended since, also by another process sharing the storage. */
    const sync = async () => apply(await log.read(MISSIONS_STREAM, { after: head }));
    await sync();

    /** Changes run one at a time; each appends only if nobody appended since it read. */
    let queue: Promise<unknown> = Promise.resolve();
    function change<T>(
      invocation: Invocation,
      /** No `type`: nothing changes, nothing is appended. */
      decide: (state: MissionsState) => { type?: MissionEventType; record: T },
    ): Promise<T> {
      const run = async () => {
        for (let attempt = 1; ; attempt += 1) {
          await sync();
          const { type, record } = decide(state);
          if (type === undefined) return record;
          const payload = {
            [MISSION_EVENT_RECORD[type]]: record,
            ...(recordedBy(invocation) === undefined ? {} : { by: recordedBy(invocation) }),
            ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
          } as unknown as Json;
          try {
            apply(await log.append(MISSIONS_STREAM, [{ type, payload }], { expectedHead: head }));
            return record;
          } catch (error) {
            if (!(error instanceof StorageError && error.code === "CONFLICT")) throw error;
            if (attempt >= MAX_ATTEMPTS) {
              throw new MissionsError(
                "MISSIONS_BUSY",
                `Other writers kept changing the missions stream; ${MAX_ATTEMPTS} attempts failed`,
                { attempts: MAX_ATTEMPTS },
              );
            }
          }
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    }

    // --- Lookups ------------------------------------------------------------------
    const getMission = (current: MissionsState, missionId: string) => {
      const mission = current.missions[missionId];
      if (mission === undefined)
        throw new MissionsError("MISSION_NOT_FOUND", `No mission ${missionId}`, { missionId });
      return mission;
    };
    const getSlice = (current: MissionsState, sliceId: string) => {
      const slice = current.slices[sliceId];
      if (slice === undefined)
        throw new MissionsError("SLICE_NOT_FOUND", `No slice ${sliceId}`, { sliceId });
      return slice;
    };
    /**
     * Projects belong to whatever registers `projects.list` (jhin.threads), looked
     * up at call time; without it there are no projects to check against (D643).
     * The call runs as the node, not the caller: it only checks an id the caller
     * named and reads the project's name for the Markdown heading.
     */
    const projects = async (): Promise<{ id: string; name: string }[] | undefined> => {
      try {
        return (await context.commands.execute("projects.list", {})) as {
          id: string;
          name: string;
        }[];
      } catch (error) {
        // Only projects.list itself missing means no projects, not a command it calls.
        const { code, details } = error as { code?: unknown; details?: { command?: unknown } };
        if (code === "COMMAND_NOT_FOUND" && details?.command === "projects.list") return undefined;
        throw error;
      }
    };
    /**
     * The missions with `projectDeleted` where their project is gone (D1399): a
     * deleted project's missions stay, readable and deletable, marked from
     * the known projects at read time. Without `projects.list` nothing is marked.
     */
    const marked = async (missions: readonly Mission[]): Promise<Mission[]> => {
      const known = await projects();
      if (known === undefined) return [...missions];
      const ids = new Set(known.map((project) => project.id));
      return missions.map((mission) =>
        ids.has(mission.projectId) ? mission : { ...mission, projectDeleted: true },
      );
    };
    const assertProject = async (projectId: string) => {
      const known = await projects();
      if (known !== undefined && !known.some((project) => project.id === projectId))
        throw new MissionsError("PROJECT_NOT_FOUND", `No project ${projectId}`, { projectId });
    };

    /**
     * The order of a mission's slices stays a set of waves (D644): a slice
     * depends only on slices of its mission in earlier waves, so no order can
     * loop, and every slice depending on it stays in a later wave.
     */
    const assertOrder = (current: MissionsState, slice: Slice, before?: Slice) => {
      for (const id of slice.dependsOn) {
        // A slice newly depending on a dropped one could never start.
        if (current.slices[id]?.status === "dropped" && !before?.dependsOn.includes(id)) {
          throw new MissionsError("SLICE_ORDER_INVALID", `Slice ${id} is dropped`, {
            sliceId: slice.id,
            dependsOn: id,
          });
        }
        const dependency = current.slices[id];
        if (dependency === undefined || dependency.missionId !== slice.missionId) {
          throw new MissionsError(
            "SLICE_ORDER_INVALID",
            `Slice ${id} is not a slice of mission ${slice.missionId}`,
            { sliceId: slice.id, dependsOn: id },
          );
        }
        if (dependency.wave >= slice.wave) {
          throw new MissionsError(
            "SLICE_ORDER_INVALID",
            `Slice ${id} is in wave ${dependency.wave}: a dependency must be in an earlier wave than ${slice.wave}`,
            { sliceId: slice.id, dependsOn: id },
          );
        }
      }
      for (const other of slicesOf(current, slice.missionId)) {
        // A dropped dependant never starts, so it holds nothing back.
        if (
          other.status !== "dropped" &&
          other.dependsOn.includes(slice.id) &&
          other.wave <= slice.wave
        ) {
          throw new MissionsError(
            "SLICE_ORDER_INVALID",
            `Slice ${other.id} depends on this one and is in wave ${other.wave}: move it first`,
            { sliceId: slice.id, dependant: other.id },
          );
        }
      }
    };
    const assertStep = (mission: Mission, step: string | undefined, sliceId?: string) => {
      if (step !== undefined && !mission.process.slice.some((candidate) => candidate.id === step)) {
        throw new MissionsError(
          "SLICE_STEP_INVALID",
          sliceId === undefined
            ? `${step} is not a step of the slice process of mission ${mission.id}`
            : `Slice ${sliceId} is at step ${step}, which the new slice process of mission ${mission.id} lacks: move it first`,
          { missionId: mission.id, step, ...(sliceId === undefined ? {} : { sliceId }) },
        );
      }
    };
    const assertMissionStep = (mission: Mission, step: string | undefined) => {
      if (
        step !== undefined &&
        !mission.process.mission.some((candidate) => candidate.id === step)
      ) {
        throw new MissionsError(
          "MISSION_STEP_INVALID",
          `${step} is not a step of mission ${mission.id}'s own process`,
          { missionId: mission.id, step },
        );
      }
    };
    /** A slice reviews slices of its mission in earlier waves (D1243), as it depends on them. */
    const assertReviews = (current: MissionsState, slice: Slice) => {
      for (const id of slice.reviews ?? []) {
        const reviewed = current.slices[id];
        if (
          reviewed === undefined ||
          reviewed.missionId !== slice.missionId ||
          reviewed.wave >= slice.wave
        ) {
          throw new MissionsError(
            "SLICE_ORDER_INVALID",
            `Slice ${slice.id} can review only slices of its mission in earlier waves, not ${id}`,
            { sliceId: slice.id, reviews: id },
          );
        }
      }
    };
    const assertProof = (slice: Slice) => {
      if (slice.status === "done" && slice.proof === undefined)
        throw new MissionsError("PROOF_REQUIRED", "A slice is done once its proof is recorded", {
          sliceId: slice.id,
        });
    };

    const read = { permissions: ["missions.read"] } as const;
    const write = { permissions: ["missions.write"] } as const;
    // Each command runs on the mission's node, this one unless `node` names another (D1542).
    const nodeId = context.services.tryGet<HostIdentity>(HOST_IDENTITY_CAPABILITY)?.nodeId;
    const register = <I extends z.ZodType, O extends z.ZodType>(
      definition: CommandDefinition<I, O>,
    ) =>
      context.commands.register(
        onMissionNode(definition, {
          ...(nodeId === undefined ? {} : { nodeId }),
          execute: (name, input, invocation) => context.commands.execute(name, input, invocation),
          callerId: context.plugin.id,
        }),
      );

    // --- Intent -------------------------------------------------------------------
    // The titles of this plugin's permissions (security.md D961).
    describePermissions(context, {
      "missions.read": {
        title: "View missions",
        description: "Read intents, missions and slices.",
      },
      "missions.write": {
        title: "Manage missions",
        description: "Set intents, and change missions and slices.",
      },
    });
    register({
      name: "missions.intent.get",
      description: "A project's intent (what it is for) and its process between missions",
      input: z.object({ projectId: z.string() }),
      output: ProjectIntentView,
      ...read,
      handler: async ({ projectId }) => {
        await assertProject(projectId);
        await sync();
        return state.intents[projectId] ?? { projectId, intent: "", process: [] };
      },
    });
    register({
      name: "missions.intent.set",
      description:
        "Sets a project's intent, one paragraph on what the project is for, and its process between missions",
      input: z.object({
        projectId: z.string(),
        intent: Text.optional(),
        process: Steps.optional(),
      }),
      output: ProjectIntent,
      ...write,
      handler: async ({ projectId, intent, process }, invocation) => {
        await assertProject(projectId);
        return change(invocation, (current) => {
          const previous = current.intents[projectId];
          const next = ProjectIntent.parse({
            projectId,
            intent: intent ?? previous?.intent ?? "",
            process: process ?? previous?.process ?? [],
            updatedAt: previous?.updatedAt ?? "",
          });
          if (previous !== undefined && same(next, previous)) return { record: previous };
          return { type: MissionEvents.intentSet, record: { ...next, updatedAt: now() } };
        });
      },
    });

    // --- Missions -----------------------------------------------------------------
    register({
      name: "missions.list",
      description: "Missions of the node, or of one project, oldest first",
      input: z.object({ projectId: z.string().optional() }),
      output: z.array(Mission),
      ...read,
      handler: async ({ projectId }) => {
        if (projectId !== undefined) await assertProject(projectId);
        await sync();
        return marked(
          projectId === undefined
            ? Object.values(state.missions).toSorted((a, b) =>
                a.createdAt.localeCompare(b.createdAt),
              )
            : missionsOf(state, projectId),
        );
      },
    });
    register({
      name: "missions.get",
      description: "A mission with its slices, by wave",
      input: z.object({ missionId: z.string() }),
      output: z.object({ mission: Mission, slices: z.array(Slice) }),
      ...read,
      handler: async ({ missionId }) => {
        await sync();
        const [mission] = await marked([getMission(state, missionId)]);
        return { mission: mission!, slices: slicesOf(state, missionId) };
      },
    });
    register({
      name: "missions.catalog",
      description:
        "Every intent, mission and slice of this node, and the head of the `missions` stream they reflect: follow the stream after `head` to keep them current",
      input: z.object({}),
      output: z.object({
        head: z.number(),
        intents: z.array(ProjectIntent),
        missions: z.array(Mission),
        slices: z.array(Slice),
      }),
      ...read,
      handler: async () => {
        await sync();
        return {
          head,
          intents: Object.values(state.intents),
          missions: await marked(Object.values(state.missions)),
          slices: Object.values(state.slices),
        };
      },
    });
    register({
      name: "missions.create",
      description:
        "Plans a mission of a project: what it achieves when done (its outcome) and its process; slices are added with slices.create",
      input: z.object({
        projectId: z.string(),
        title: Title,
        outcome: Text,
        status: MissionStatus.default("planned"),
        process: MissionProcess.optional(),
      }),
      output: Mission,
      ...write,
      handler: async ({ projectId, title, outcome, status, process }, invocation) => {
        await assertProject(projectId);
        const at = now();
        return change(invocation, () => ({
          type: MissionEvents.missionCreated,
          record: {
            id: Crypto.randomUUID(),
            projectId,
            title,
            outcome,
            status,
            process: process ?? DEFAULT_MISSION_PROCESS,
            createdAt: at,
            updatedAt: at,
          } satisfies Mission,
        }));
      },
    });
    register({
      name: "missions.update",
      description: "Changes a mission's title, outcome, status or process",
      input: z.object({
        missionId: z.string(),
        title: Title.optional(),
        outcome: Text.optional(),
        status: MissionStatus.optional(),
        process: MissionProcess.optional(),
        step: z.string().nullable().optional().meta({
          description:
            "Takes a step of the mission's own process (e.g. commit, merge) before running it; null clears it. A step that needs a review is refused while a slice changed after its last review (D1241)",
        }),
      }),
      output: Mission,
      ...write,
      handler: async ({ missionId, step, ...fields }, invocation) => {
        if (typeof step === "string") {
          // Taking a step, also the same one again, goes through the hook first: a
          // plugin refuses it by throwing (D1241).
          await sync();
          const mission = getMission(state, missionId);
          const process = fields.process ?? mission.process;
          assertMissionStep({ ...mission, process }, step);
          await context.hooks.run(
            MISSION_STEP_HOOK,
            { mission: { ...mission, process }, step },
            async (input) => input,
          );
        }
        return change(invocation, (current) => {
          const mission = getMission(current, missionId);
          const defined = Object.fromEntries(
            Object.entries(fields).filter(([, value]) => value !== undefined),
          );
          const { step: _step, ...kept } = mission;
          const nextStep = step === undefined ? mission.step : (step ?? undefined);
          const next = Mission.parse({
            ...kept,
            ...defined,
            ...(nextStep === undefined ? {} : { step: nextStep }),
            updatedAt: mission.updatedAt,
          });
          if (same(next, mission)) return { record: mission };
          // A new process keeps the mission's and every slice's step one of its steps (D648).
          assertMissionStep(next, next.step);
          for (const slice of slicesOf(current, missionId)) assertStep(next, slice.step, slice.id);
          return { type: MissionEvents.missionUpdated, record: { ...next, updatedAt: now() } };
        });
      },
    });

    register({
      name: "missions.delete",
      description:
        "Deletes a mission with its slices, as a tombstone: the records leave the state, the event log keeps what happened (D1395). Refused while an orchestrator run of the mission is active",
      input: z.object({ missionId: z.string() }),
      output: Mission,
      ...write,
      handler: async ({ missionId }, invocation) => {
        await sync();
        const mission = getMission(state, missionId);
        await context.hooks.run(MISSION_DELETE_HOOK, { mission }, async (input) => input);
        return change(invocation, (current) => {
          const gone = getMission(current, missionId);
          return { type: MissionEvents.missionDeleted, record: gone };
        });
      },
    });

    // --- Reading as Markdown and the intent chain ---------------------------------
    register({
      name: "missions.markdown",
      description:
        "A project's intent and missions as Markdown, or only one mission: what people and agents read",
      input: z.union([z.object({ missionId: z.string() }), z.object({ projectId: z.string() })]),
      output: z.object({ markdown: z.string() }),
      ...read,
      handler: async (input) => {
        await sync();
        if ("missionId" in input) {
          const mission = getMission(state, input.missionId);
          return {
            markdown: renderMarkdown(state, mission.projectId, {
              missionId: mission.id,
              projectName: await projectName(mission.projectId),
            }),
          };
        }
        await assertProject(input.projectId);
        return {
          markdown: renderMarkdown(state, input.projectId, {
            projectName: await projectName(input.projectId),
          }),
        };
      },
    });
    const projectName = async (projectId: string) =>
      (await projects())?.find((project) => project.id === projectId)?.name;
    register({
      name: "missions.chain",
      description:
        "The intent chain of a slice, or of the slice a thread works on (nodeId: only that node's thread): slice spec → mission outcome → project intent",
      input: z.union([
        z.object({ sliceId: z.string() }),
        z.object({ threadId: z.string(), nodeId: z.string().optional() }),
      ]),
      output: IntentChain,
      ...read,
      handler: async (input) => {
        await sync();
        if ("sliceId" in input) return chainOf(getSlice(state, input.sliceId));
        // The thread's open slice changed last; a finished one when it has no open one.
        const linked = Object.values(state.slices)
          .filter((slice) =>
            slice.threads.some((thread) => linksThread(thread, input.threadId, input.nodeId)),
          )
          .toSorted(
            (a, b) =>
              Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt.localeCompare(a.updatedAt),
          );
        const slice = linked[0];
        if (slice === undefined)
          throw new MissionsError("SLICE_NOT_FOUND", `No slice links thread ${input.threadId}`, {
            threadId: input.threadId,
          });
        return chainOf(slice);
      },
    });
    const chainOf = (slice: Slice) => {
      getMission(state, slice.missionId);
      const chain = intentChain(state, slice.id);
      if (chain === undefined) throw new MissionsError("SLICE_NOT_FOUND", `No slice ${slice.id}`);
      return chain;
    };
    const isOpen = (slice: Slice) => slice.status !== "done" && slice.status !== "dropped";
    /** A thread by id; with a `nodeId`, only the thread of that node. */
    const linksThread = (thread: SliceThread, threadId: string, nodeId: string | undefined) =>
      thread.threadId === threadId && (nodeId === undefined || thread.nodeId === nodeId);

    // --- Slices -------------------------------------------------------------------
    register({
      name: "slices.get",
      description: "A slice: its spec, order, assignee, status, threads and proof",
      input: z.object({ sliceId: z.string() }),
      output: Slice,
      ...read,
      handler: async ({ sliceId }) => {
        await sync();
        return getSlice(state, sliceId);
      },
    });
    register({
      name: "slices.list",
      description:
        "Slices by wave, filtered by mission, project, assignee, status or a thread working on them (nodeId: only that node's thread)",
      input: z.object({
        missionId: z.string().optional(),
        projectId: z.string().optional(),
        assignee: z.string().optional(),
        status: SliceStatus.optional(),
        threadId: z.string().optional(),
        nodeId: z.string().optional(),
      }),
      output: z.array(Slice),
      ...read,
      handler: async (filter) => {
        if (filter.projectId !== undefined) await assertProject(filter.projectId);
        await sync();
        const { threadId } = filter;
        return Object.values(state.slices)
          .filter(
            (slice) =>
              (filter.missionId === undefined || slice.missionId === filter.missionId) &&
              (filter.projectId === undefined || slice.projectId === filter.projectId) &&
              (filter.assignee === undefined || slice.assignee === filter.assignee) &&
              (filter.status === undefined || slice.status === filter.status) &&
              (threadId === undefined ||
                slice.threads.some((thread) => linksThread(thread, threadId, filter.nodeId))),
          )
          .toSorted(
            (a, b) =>
              a.missionId.localeCompare(b.missionId) ||
              a.wave - b.wave ||
              a.createdAt.localeCompare(b.createdAt),
          );
      },
    });
    register({
      name: "slices.create",
      description:
        "Adds a slice to a mission: one change with a spec of what must work. The wave defaults to the one after its dependencies",
      input: z.object({
        missionId: z.string(),
        title: Title,
        spec: Text,
        wave: z.number().int().min(1).optional(),
        dependsOn: z.array(z.string()).default([]),
        reviews: z.array(z.string()).optional().meta({
          description:
            "Slices of the mission, in earlier waves, whose work this slice reviews (D1243)",
        }),
        assignee: Assignee.optional(),
        status: SliceStatus.exclude(["done", "dropped"]).default("planned"),
      }),
      output: Slice,
      ...write,
      handler: ({ missionId, wave, dependsOn, reviews, assignee, ...fields }, invocation) =>
        change(invocation, (current) => {
          const mission = getMission(current, missionId);
          if (mission.status === "done" || mission.status === "dropped") {
            throw new MissionsError("MISSION_CLOSED", `Mission ${missionId} is ${mission.status}`, {
              missionId,
            });
          }
          const at = now();
          const slice: Slice = {
            id: Crypto.randomUUID(),
            missionId,
            projectId: mission.projectId,
            ...fields,
            wave:
              wave ??
              1 +
                Math.max(
                  0,
                  ...[...dependsOn, ...(reviews ?? [])].map((id) => current.slices[id]?.wave ?? 0),
                ),
            dependsOn: [...new Set(dependsOn)],
            ...(reviews === undefined || reviews.length === 0
              ? {}
              : { reviews: [...new Set(reviews)] }),
            ...(assignee === undefined ? {} : { assignee }),
            threads: [],
            createdAt: at,
            updatedAt: at,
          };
          assertOrder(current, slice);
          assertReviews(current, slice);
          return { type: MissionEvents.sliceCreated, record: slice };
        }),
    });
    register({
      name: "slices.update",
      description:
        "Changes a slice's title, spec, wave, dependencies, assignee, status or step; null clears the assignee or step. Done needs a proof (slices.prove)",
      input: z.object({
        sliceId: z.string(),
        title: Title.optional(),
        spec: Text.optional(),
        wave: z.number().int().min(1).optional(),
        dependsOn: z.array(z.string()).optional(),
        reviews: z.array(z.string()).optional(),
        assignee: Assignee.nullable().optional(),
        status: SliceStatus.optional(),
        step: z.string().nullable().optional(),
      }),
      output: Slice,
      ...write,
      handler: ({ sliceId, assignee, step, dependsOn, reviews, ...fields }, invocation) =>
        change(invocation, (current) => {
          const previous = getSlice(current, sliceId);
          const defined = Object.fromEntries(
            Object.entries(fields).filter(([, value]) => value !== undefined),
          );
          // A slice leaving done leaves its proof behind: done again takes slices.prove (D646).
          const reopened = previous.status === "done" && (fields.status ?? "done") !== "done";
          const {
            assignee: _assignee,
            step: _step,
            proof: _proof,
            reviews: _reviews,
            ...kept
          } = previous;
          const nextReviews = reviews === undefined ? previous.reviews : [...new Set(reviews)];
          const rest =
            reopened || previous.proof === undefined ? kept : { ...kept, proof: previous.proof };
          const nextAssignee = assignee === undefined ? previous.assignee : (assignee ?? undefined);
          const nextStep = step === undefined ? previous.step : (step ?? undefined);
          const slice = Slice.parse({
            ...rest,
            ...defined,
            ...(dependsOn === undefined ? {} : { dependsOn: [...new Set(dependsOn)] }),
            ...(nextReviews === undefined || nextReviews.length === 0
              ? {}
              : { reviews: nextReviews }),
            ...(nextAssignee === undefined ? {} : { assignee: nextAssignee }),
            ...(nextStep === undefined ? {} : { step: nextStep }),
          });
          if (same(slice, previous)) return { record: previous };
          // A dropped slice is kept as it was dropped (D651).
          if (previous.status === "dropped") {
            throw new MissionsError("SLICE_DROPPED", `Slice ${sliceId} is dropped`, { sliceId });
          }
          assertOrder(current, slice, previous);
          assertReviews(current, slice);
          assertStep(getMission(current, slice.missionId), slice.step);
          assertProof(slice);
          return { type: MissionEvents.sliceUpdated, record: { ...slice, updatedAt: now() } };
        }),
    });
    register({
      name: "slices.delete",
      description:
        "Deletes a slice, as a tombstone: the record leaves the state, the event log keeps what happened (D1395). Refused while another slice depends on it or reviews it, or an orchestrator run of its mission is active",
      input: z.object({ sliceId: z.string() }),
      output: Slice,
      ...write,
      handler: async ({ sliceId }, invocation) => {
        await sync();
        const slice = getSlice(state, sliceId);
        const mission = getMission(state, slice.missionId);
        await context.hooks.run(MISSION_DELETE_HOOK, { mission, sliceId }, async (input) => input);
        return change(invocation, (current) => {
          const gone = getSlice(current, sliceId);
          const user = slicesOf(current, gone.missionId).find(
            (other) => other.dependsOn.includes(sliceId) || (other.reviews ?? []).includes(sliceId),
          );
          if (user !== undefined) {
            throw new MissionsError(
              "SLICE_IN_USE",
              `Slice ${user.id} ${user.dependsOn.includes(sliceId) ? "depends on" : "reviews"} this one: delete or change it first`,
              { sliceId, user: user.id },
            );
          }
          return { type: MissionEvents.sliceDeleted, record: gone };
        });
      },
    });
    register({
      name: "slices.link",
      description:
        "Records a thread as working on a slice; nodeId when the thread is on another node",
      input: z.object({ sliceId: z.string() }).extend(SliceThread.shape),
      output: Slice,
      ...write,
      handler: ({ sliceId, threadId, nodeId }, invocation) =>
        change(invocation, (current) => {
          const slice = getSlice(current, sliceId);
          if (slice.status === "dropped") {
            throw new MissionsError("SLICE_DROPPED", `Slice ${sliceId} is dropped`, { sliceId });
          }
          const linked = slice.threads.some(
            (thread) => thread.threadId === threadId && thread.nodeId === nodeId,
          );
          if (linked) return { record: slice };
          return {
            type: MissionEvents.sliceUpdated,
            record: {
              ...slice,
              threads: [
                ...slice.threads,
                { threadId, ...(nodeId === undefined ? {} : { nodeId }) },
              ],
              updatedAt: now(),
            },
          };
        }),
    });
    register({
      name: "slices.unlink",
      description:
        "Removes a thread from a slice; without nodeId, that thread id on any node, as slices.list matches it",
      input: z.object({ sliceId: z.string() }).extend(SliceThread.shape),
      output: Slice,
      ...write,
      handler: ({ sliceId, threadId, nodeId }, invocation) =>
        change(invocation, (current) => {
          const slice = getSlice(current, sliceId);
          const threads = slice.threads.filter((thread) => !linksThread(thread, threadId, nodeId));
          if (threads.length === slice.threads.length) return { record: slice };
          return {
            type: MissionEvents.sliceUpdated,
            record: { ...slice, threads, updatedAt: now() },
          };
        }),
    });
    register({
      name: "slices.prove",
      description:
        "Records a slice's proof (commands with their output, screenshots, links) and marks it done. Keep it small: what shows the spec works, once",
      input: z.object({ sliceId: z.string(), items: ProofItems }),
      output: Slice,
      ...write,
      handler: ({ sliceId, items }, invocation) =>
        change(invocation, (current) => {
          const slice = getSlice(current, sliceId);
          if (slice.status === "dropped") {
            throw new MissionsError("SLICE_DROPPED", `Slice ${sliceId} is dropped`, { sliceId });
          }
          const at = now();
          return {
            type: MissionEvents.sliceProved,
            record: {
              ...slice,
              status: "done",
              proof: {
                items,
                recordedAt: at,
                ...(recordedBy(invocation) === undefined ? {} : { by: recordedBy(invocation) }),
              },
              updatedAt: at,
            } satisfies Slice,
          };
        }),
    });

    /**
     * The files of a slice's work as a review sees them (D1242): where it
     * lives (the thread named, else the slice's first thread of this node,
     * else its project) and their git tree, through `git.tree` when a plugin
     * registers it. Without it, or outside a repository, a review records none.
     */
    const workOf = async (
      slice: Slice,
      threadId: string | undefined,
    ): Promise<ReviewedWork | undefined> => {
      const thread =
        threadId ?? slice.threads.find((linked) => linked.nodeId === undefined)?.threadId;
      try {
        const work = (await context.commands.execute(
          "git.tree",
          thread === undefined
            ? { projectId: slice.projectId, exclude: REVIEW_TREE_EXCLUDE }
            : { threadId: thread, exclude: REVIEW_TREE_EXCLUDE },
        )) as { projectId: string; path: string; tree: string };
        return {
          projectId: work.projectId,
          ...(thread === undefined ? {} : { threadId: thread }),
          path: work.path,
          tree: work.tree,
        };
      } catch (error) {
        const { code, details } = error as { code?: unknown; details?: { command?: unknown } };
        if (code === "COMMAND_NOT_FOUND" && details?.command === "git.tree") return undefined;
        if (code === "NOT_A_REPOSITORY") return undefined;
        throw error;
      }
    };
    register({
      name: "slices.review",
      description:
        "Records a review of a slice's work: approved or changes-requested, with notes on what was checked and found, and the git tree of the files reviewed (where the slice's thread works, or threadId's). A mission step that needs a review is refused while a slice changed after its last review",
      input: z.object({
        sliceId: z.string(),
        verdict: ReviewVerdict,
        notes: Text.optional(),
        threadId: z.string().min(1).optional().meta({
          description: "The thread whose files were reviewed, when not the slice's own",
        }),
      }),
      output: Slice,
      ...write,
      handler: async ({ sliceId, verdict, notes, threadId }, invocation) => {
        await sync();
        const work = await workOf(getSlice(state, sliceId), threadId);
        return change(invocation, (current) => {
          const slice = getSlice(current, sliceId);
          if (slice.status === "dropped") {
            throw new MissionsError("SLICE_DROPPED", `Slice ${sliceId} is dropped`, { sliceId });
          }
          const at = now();
          return {
            type: MissionEvents.sliceReviewed,
            record: {
              ...slice,
              review: {
                verdict,
                ...(notes === undefined || notes.trim() === "" ? {} : { notes }),
                ...(work === undefined ? {} : { work }),
                recordedAt: at,
                ...(recordedBy(invocation) === undefined ? {} : { by: recordedBy(invocation) }),
              },
              updatedAt: at,
            } satisfies Slice,
          };
        });
      },
    });
  },
});
