import * as Crypto from "node:crypto";

import {
  MAX_MESSAGE_LENGTH,
  MESSAGE_PERMISSION,
  ORCHESTRATION_STREAM,
  OrchestrationEvents,
  ThreadEvents,
  agentAddress,
  ownerAddress,
  parseAgentAddress,
  threadAddress,
  threadStream,
  type InboxItem,
} from "@jhin/agent-api";
import { HOST_IDENTITY_CAPABILITY, type HostIdentity } from "@jhin/host-api";
import {
  EMPTY_MISSIONS,
  IntentChain,
  MISSIONS_STREAM,
  MISSION_STEP_HOOK,
  Mission,
  MissionEvents,
  MissionProgress,
  ReviewCheck,
  Slice,
  Step,
  applyMissionEvent,
  intentChain,
  missionProgress,
  reviewCheck,
  reviewedWork,
  slicesOf,
  type MissionsState,
} from "@jhin/missions-api";
import { definePlugin, z, type Disposable, type Invocation } from "@jhin/sdk";
import {
  EVENTLOG_CAPABILITY,
  KV_CAPABILITY,
  type EventLog,
  type KeyValueStore,
  type StoredEvent,
} from "@jhin/storage-api";

import { handoffText, refocusText, type RefocusReason } from "./brief.ts";
import { reportText, type ReportEnd } from "./report.ts";
import {
  REVIEW_BRIEF_LENGTH,
  cut,
  owningPlans,
  reviewBriefText,
  type Part,
  type ReviewedWork,
} from "./review.ts";
import { ORCHESTRATOR_WORKFLOW } from "./workflow.ts";

export { ORCHESTRATOR_WORKFLOW };

const NAMESPACE = "jhin.orchestrator";
const CONFIG_SECTION = "jhin.orchestrator";
export const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 60 * 60 * 1000;
/** The permission W10 asks of `workflows.run` (orchestration.md D375). */
const WORKFLOWS_RUN = "workflows.run";

const Config = z
  .object({
    refocusOnCompaction: z.boolean().default(true).meta({
      title: "Refocus after a compaction",
      description:
        "Hand an agent working on a slice its intent chain when its context was compacted.",
    }),
    refocusEveryTurns: z
      .number()
      .int()
      .min(0)
      .default(10)
      .meta({
        title: "Refocus every … turns",
        description:
          "Hand an agent working on a slice its intent chain every this many turns of its thread; 0 turns it off.",
        examples: [10],
      }),
    reviewSteps: z
      .array(z.string())
      .default(["commit", "merge"])
      .meta({
        title: "Steps that need a review",
        description:
          "Mission steps taken only once every slice was reviewed after its last change, whatever the mission's process says; a step marked review in the process needs one too.",
        examples: [["commit", "merge"]],
      }),
  })
  .meta({
    title: "Orchestrator",
    description: "Running missions wave by wave, and refocusing agents on their intent.",
  });
type Config = z.infer<typeof Config>;

export type OrchestratorErrorCode =
  | "MISSION_NOT_FOUND"
  | "SLICE_NOT_FOUND"
  /** The mission is done or dropped. */
  | "MISSION_CLOSED"
  /** Not a planned slice of the mission's current wave with an assignee here (D703). */
  | "SLICE_NOT_READY"
  /** The assignee is an agent or owner of another node: A2's `agents.send` reaches it. */
  | "AGENT_ELSEWHERE"
  /** No thread to run the workflow from, or to refocus. */
  | "THREAD_REQUIRED"
  /** The mission's lead asked the owner, and the team waits for the answer (D1223). */
  | "ESCALATION_OPEN"
  /** The step needs a review, and a slice changed after its last one (D1241). */
  | "REVIEW_REQUIRED"
  /** The slice reviews no slice (D1244). */
  | "NOT_A_REVIEW";

class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: OrchestratorErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const MissionRef = Mission.pick({ id: true, title: true, status: true, outcome: true });

const Next = MissionProgress.extend({
  mission: MissionRef,
  /** The head of the `missions` stream this answer reflects: `missions.wait` waits past it. */
  head: z.number(),
  /** The mission's own steps, run between its waves (D648). */
  steps: z.array(Step),
  /** The project's steps between missions. */
  projectSteps: z.array(Step),
  /**
   * The ids of the lead's asks to the owner still open in the inbox: the
   * team waits for their answer, and no slice is handed meanwhile (D1223).
   */
  escalations: z.array(z.string()),
});

const ThreadView = z
  .object({
    id: z.string(),
    projectId: z.string(),
    agentId: z.string().optional(),
    generationOf: z.string().optional(),
    lastTurn: z.object({ agentId: z.string() }).loose().optional(),
  })
  .loose();

/** What the client shows of a mission's run (D1086): W10's workflow, without its agents. */
const OrchestratorRun = z.object({
  workflowId: z.string(),
  parentThreadId: z.string(),
  status: z.string(),
  currentPhase: z.string().optional(),
  /** Its last five log lines. */
  logs: z.array(z.string()),
  result: z.json().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().optional(),
});

export default definePlugin({
  async activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const kv = context.services.get<KeyValueStore>(KV_CAPABILITY);
    const { nodeId } = context.services.get<HostIdentity>(HOST_IDENTITY_CAPABILITY);
    const config = () => Config.parse(context.config.get(CONFIG_SECTION) ?? {});
    /** As the node: lookups this plugin's own commands promise (D703). */
    const run = <T>(name: string, input: unknown, invocation?: Invocation) =>
      context.commands.execute(name, input, invocation) as Promise<T>;
    let disposed = false;
    /** Waits of `missions.wait` still open: they end with the plugin. */
    const waits = new Set<() => void>();
    context.subscriptions.add({
      dispose: () => {
        disposed = true;
        for (const end of waits) end();
      },
    });

    // --- The fold of the `missions` stream (D641), read like any client's ------
    let state: MissionsState = EMPTY_MISSIONS;
    let head = 0;
    const changed = new Set<(event: StoredEvent) => void>();
    /** Set once the stream is caught up: what closed before is no news to report. */
    let caughtUp = false;
    const apply = (events: readonly StoredEvent[]) => {
      for (const event of events) {
        if (event.sequence <= head) continue;
        const missionId =
          event.type === MissionEvents.missionUpdated
            ? (event.payload as { mission?: { id?: string } } | null)?.mission?.id
            : undefined;
        const before = missionId === undefined ? undefined : state.missions[missionId]?.status;
        state = applyMissionEvent(state, event);
        head = event.sequence;
        for (const listener of changed) listener(event);
        const after = missionId === undefined ? undefined : state.missions[missionId];
        // A mission the lead closed: its report goes to the owner (D1222).
        if (caughtUp && after !== undefined && before !== undefined && !isClosed(before)) {
          if (after.status === "done" || after.status === "dropped") {
            reportLater(after.id, after.status, `${after.status}-${after.updatedAt}`);
          }
        }
      }
      watchThreads();
    };
    /** Catches up, also with what another process sharing the storage appended. */
    const sync = async () => apply(await log.read(MISSIONS_STREAM, { after: head }));
    context.subscriptions.add(log.subscribe(MISSIONS_STREAM, (event) => apply([event])));

    const getMission = (missionId: string) => {
      const mission = state.missions[missionId];
      if (mission === undefined)
        throw new OrchestratorError("MISSION_NOT_FOUND", `No mission ${missionId}`, { missionId });
      return mission;
    };
    const getSlice = (sliceId: string) => {
      const slice = state.slices[sliceId];
      if (slice === undefined)
        throw new OrchestratorError("SLICE_NOT_FOUND", `No slice ${sliceId}`, { sliceId });
      return slice;
    };
    const isOpen = (slice: Slice) => slice.status !== "done" && slice.status !== "dropped";
    const isClosed = (status: Mission["status"]) => status === "done" || status === "dropped";
    const hasCommand = (name: string) =>
      context.commands.list().some((command) => command.name === name);

    const getThread = async (threadId: string) => {
      const { thread, running } = await run<{ thread: unknown; running?: string }>("threads.get", {
        threadId,
      });
      return { thread: ThreadView.parse(thread), running };
    };

    // --- The lead and the owner (L1: D1222, D1223) ------------------------------
    /** The mission's lead: the thread its last orchestrator run started from, and its address. */
    const leadOf = async (missionId: string) => {
      const last = (await kv.get(NAMESPACE, `run/${missionId}`)) as
        | { parentThreadId?: string }
        | undefined;
      const threadId = last?.parentThreadId;
      if (threadId === undefined) return undefined;
      const thread = await getThread(threadId).then(
        (found) => found.thread,
        () => undefined,
      );
      // A lead's thread that is gone has nobody to report or wait for.
      if (thread === undefined) return undefined;
      // A thread sends as its agent when it is one of its generations (D622).
      const address =
        thread.generationOf === undefined
          ? threadAddress(nodeId, threadId)
          : agentAddress(nodeId, thread.generationOf);
      return { threadId, address };
    };
    /** The lead's asks to the owner still open in the inbox (D1223). */
    const escalationsOf = async (missionId: string): Promise<string[]> => {
      if (!hasCommand("agents.inbox.list")) return [];
      const lead = await leadOf(missionId);
      if (lead === undefined) return [];
      const { items } = await run<{ items: InboxItem[] }>("agents.inbox.list", {});
      return items
        .filter(
          (item) =>
            item.status === "open" &&
            item.message.kind === "ask" &&
            item.message.from === lead.address,
        )
        .map((item) => item.message.messageId);
    };
    /** Sends the lead's report to the owner, once per id (D1222). */
    async function report(missionId: string, end: ReportEnd, id: string, error?: string) {
      const closed = end === "done" || end === "dropped";
      // The lead's word belongs to this close only: taken now, whatever happens next.
      const summaryKey = `summary/${missionId}`;
      const summary = closed
        ? ((await kv.get(NAMESPACE, summaryKey)) as string | undefined)
        : undefined;
      if (summary !== undefined) await kv.delete(NAMESPACE, summaryKey);
      if (!hasCommand("agents.send")) return;
      const lead = await leadOf(missionId);
      if (lead === undefined) {
        context.log.info("no report: the mission never ran from a lead's thread", { missionId });
        return;
      }
      await sync();
      const mission = getMission(missionId);
      await run(
        "agents.send",
        {
          to: ownerAddress(nodeId),
          messageId: `report-${missionId}-${id}`,
          body: reportText({ mission, slices: slicesOf(state, missionId), end, summary, error }),
        },
        // As the lead's thread, so the owner hears it from the lead (D622).
        { threadId: lead.threadId },
      );
    }
    let reporting: Promise<unknown> = Promise.resolve();
    function reportLater(missionId: string, end: ReportEnd, id: string, error?: string) {
      reporting = reporting
        .then(() => report(missionId, end, id, error))
        .catch((failure: unknown) => {
          if (!disposed) {
            context.log.warn("the mission's report did not reach the owner", {
              missionId,
              error: String(failure),
            });
          }
        });
    }
    // A run that failed or was stopped while its mission is open is reported too:
    // the lead's thread may never wake to tell (D1222).
    context.subscriptions.add(
      log.subscribe(ORCHESTRATION_STREAM, (event) => {
        if (disposed || event.type !== OrchestrationEvents.workflowUpdated) return;
        const record = event.payload as {
          workflowId?: string;
          status?: string;
          error?: string;
        } | null;
        if (record?.workflowId === undefined) return;
        if (record.status !== "failed" && record.status !== "stopped") return;
        const { workflowId, status, error } = record;
        reporting = reporting
          .then(async () => {
            const owned = (await kv.get(NAMESPACE, `workflow/${workflowId}`)) as
              | { missionId?: string }
              | undefined;
            if (owned?.missionId === undefined) return;
            // Only the mission's current run speaks for it: an older one ending late is no news.
            const current = (await kv.get(NAMESPACE, `run/${owned.missionId}`)) as
              | { workflowId?: string }
              | undefined;
            if (current?.workflowId !== workflowId) return;
            await sync();
            const mission = state.missions[owned.missionId];
            if (mission === undefined || isClosed(mission.status)) return;
            reportLater(owned.missionId, status, workflowId, error);
          })
          .catch(() => undefined);
      }),
    );
    const progressOf = (mission: Mission) =>
      missionProgress(slicesOf(state, mission.id), { nodeId });

    // --- Where a mission is (D702) ---------------------------------------------
    context.commands.register({
      name: "missions.next",
      description:
        "Where a mission is: its current wave, the slices ready to hand to their assignee, those at work, and what waits for a decision (no assignee, blocked, a dropped dependency, an assignee on another node)",
      input: z.object({ missionId: z.string() }),
      output: Next,
      permissions: ["missions.read"],
      handler: async ({ missionId }) => {
        await sync();
        const mission = getMission(missionId);
        return {
          mission: {
            id: mission.id,
            title: mission.title,
            status: mission.status,
            outcome: mission.outcome,
          },
          head,
          steps: mission.process.mission,
          projectSteps: state.intents[mission.projectId]?.process ?? [],
          escalations: await escalationsOf(missionId),
          ...progressOf(mission),
        };
      },
    });

    // --- Waiting for the mission to move (D704) --------------------------------
    const concerns = (missionId: string, event: StoredEvent) => {
      const payload = (event.payload ?? {}) as {
        mission?: { id?: unknown };
        slice?: { missionId?: unknown };
      };
      return payload.mission?.id === missionId || payload.slice?.missionId === missionId;
    };
    context.commands.register({
      name: "missions.wait",
      description:
        "Waits until a mission or one of its slices changes after the `missions` stream's sequence `after` (from missions.next's head), or until timeoutMs passes",
      input: z.object({
        missionId: z.string(),
        after: z.number().int().min(0),
        timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).default(DEFAULT_WAIT_MS),
      }),
      output: z.object({ head: z.number(), changed: z.boolean() }),
      permissions: ["missions.read"],
      handler: async ({ missionId, after, timeoutMs }) => {
        let listener: ((event: StoredEvent) => void) | undefined;
        let end: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const moved = new Promise<boolean>((resolve) => {
          listener = (event) => {
            if (event.sequence > after && concerns(missionId, event)) resolve(true);
          };
          end = () => resolve(false);
          changed.add(listener);
          waits.add(end);
          timer = setTimeout(end, timeoutMs);
        });
        try {
          // What came before this call, and what another process appended meanwhile.
          const missed = await log.read(MISSIONS_STREAM, { after });
          apply(missed);
          if (missed.some((event) => concerns(missionId, event))) return { head, changed: true };
          if (disposed) return { head, changed: false };
          const hit = await moved;
          return { head, changed: hit };
        } finally {
          if (listener !== undefined) changed.delete(listener);
          if (end !== undefined) waits.delete(end);
          clearTimeout(timer);
        }
      },
    });

    // --- The reviewer's brief (D1244–D1246) ------------------------------------
    /** A command's output as the node, or why there is none: a missing plugin is no failure. */
    const attempt = async <T>(name: string, input: unknown): Promise<T | { missing: string }> => {
      try {
        return await run<T>(name, input);
      } catch (error) {
        const { code, message } = error as { code?: unknown; message?: unknown };
        return {
          missing:
            code === "COMMAND_NOT_FOUND"
              ? `this node has no ${name}`
              : `${name} failed: ${String(message ?? error)}`,
        };
      }
    };
    const failed = (value: unknown): value is { missing: string } =>
      typeof value === "object" && value !== null && "missing" in value;
    type Section = { address: string; content: string };
    const section = async (projectId: string, address: string): Promise<Part> => {
      const read = await attempt<Section>("context.read", { projectId, path: address });
      return failed(read) ? { address, missing: read.missing } : { address, text: read.content };
    };
    type GitDiff = NonNullable<ReviewedWork["diff"]>;
    /** Where a reviewed slice's work lives (its first thread here, else its project) and its diff. */
    const workOf = async (reviewed: Slice): Promise<ReviewedWork> => {
      const threadId = reviewed.threads.find((thread) => thread.nodeId === undefined)?.threadId;
      const target = threadId === undefined ? { projectId: reviewed.projectId } : { threadId };
      // The branch against its base holds commits and edits alike; on the default branch, edits.
      let diff = await attempt<GitDiff>("git.diff", { ...target, scope: "branch" });
      if (failed(diff) || (diff.files.length === 0 && diff.baseRef === null))
        diff = await attempt<GitDiff>("git.diff", { ...target, scope: "uncommitted" });
      return failed(diff) ? { slice: reviewed, missing: diff.missing } : { slice: reviewed, diff };
    };
    const reviewBrief = async (slice: Slice) => {
      const { projectId } = slice;
      const work = await Promise.all(
        (slice.reviews ?? []).flatMap((id) => {
          const reviewed = state.slices[id];
          return reviewed === undefined ? [] : [workOf(reviewed)];
        }),
      );
      const library = await attempt<{ map: string; content?: string; trailhead: string }>(
        "context.map",
        { projectId, content: true },
      );
      const paths = work.flatMap((item) => item.diff?.files.map((file) => file.path) ?? []);
      const rules: Part = failed(library)
        ? { address: "AGENTS.md", missing: library.missing }
        : await section(projectId, library.trailhead);
      const plans = failed(library)
        ? []
        : await Promise.all(
            owningPlans(library.content ?? "", library.map, paths).map((address) =>
              section(projectId, address),
            ),
          );
      const loreBrief = await attempt<{ markdown: string }>("lore.brief", {
        projectId,
        reason: "request",
      });
      const lore: Part = failed(loreBrief)
        ? { address: "lore.brief", missing: loreBrief.missing }
        : { address: "lore.brief", text: loreBrief.markdown };
      const markdown = reviewBriefText({ slice, rules, plans, lore, work });
      return {
        markdown: cut(markdown, REVIEW_BRIEF_LENGTH, `review_brief { sliceId: "${slice.id}" }`),
        sources: [rules, ...plans, lore].map((part) => ({
          address: part.address,
          ...(part.missing === undefined ? {} : { missing: part.missing }),
        })),
      };
    };
    context.commands.register({
      name: "review.brief",
      description:
        "What the reviewer of a review slice reads: the project's rules (its trailhead), the plans that own the changed files, the lore, the reviewed slices with their proof and diff, and the lead's notes after them, as Markdown. Its handoff sends it",
      input: z.object({ sliceId: z.string() }),
      output: z.object({
        markdown: z.string(),
        /** Each source of the brief, and why it is missing when it is. */
        sources: z.array(z.object({ address: z.string(), missing: z.string().optional() })),
      }),
      permissions: ["missions.read"],
      handler: async ({ sliceId }) => {
        await sync();
        const slice = getSlice(sliceId);
        if (slice.reviews === undefined || slice.reviews.length === 0) {
          throw new OrchestratorError(
            "NOT_A_REVIEW",
            `Slice ${sliceId} reviews no slice: name them with slices.update { reviews }`,
            { sliceId },
          );
        }
        return reviewBrief(slice);
      },
    });

    // --- Handing a slice to its assignee (D703) --------------------------------
    context.commands.register({
      name: "slices.handoff",
      description:
        "Hands a ready slice to its assignee with agents.send: an agent of this node gets it in its current generation (the first one is started when it has none), which is linked to the slice; the owner gets it in the inbox. The slice becomes active at its process's first step. Handing an active slice again changes nothing",
      input: z.object({ sliceId: z.string() }),
      output: z.object({
        slice: Slice,
        delivered: z.enum(["agent", "owner"]),
        threadId: z.string().optional(),
        /** False when the slice was already handed. */
        handed: z.boolean(),
      }),
      permissions: ["missions.write", MESSAGE_PERMISSION],
      handler: async ({ sliceId }, invocation) => {
        await sync();
        const slice = getSlice(sliceId);
        const mission = getMission(slice.missionId);
        if (mission.status === "done" || mission.status === "dropped") {
          throw new OrchestratorError(
            "MISSION_CLOSED",
            `Mission ${mission.id} is ${mission.status}`,
            {
              missionId: mission.id,
            },
          );
        }
        const agent = slice.assignee === undefined ? undefined : parseAgentAddress(slice.assignee);
        if (slice.status === "active") {
          const linked = slice.threads.find((thread) => thread.nodeId === undefined);
          return {
            slice,
            delivered: agent === undefined ? ("owner" as const) : ("agent" as const),
            ...(agent === undefined || linked === undefined ? {} : { threadId: linked.threadId }),
            handed: false,
          };
        }
        const progress = progressOf(mission);
        if (!progress.ready.includes(slice.id)) {
          const decision = progress.decisions.find((item) => item.sliceId === slice.id);
          if (decision?.reason === "elsewhere") {
            throw new OrchestratorError(
              "AGENT_ELSEWHERE",
              `${slice.assignee} is on another node: its node orchestrates it`,
              { sliceId, assignee: slice.assignee },
            );
          }
          throw new OrchestratorError(
            "SLICE_NOT_READY",
            decision === undefined
              ? `Slice ${sliceId} is ${slice.status} in wave ${slice.wave}; wave ${progress.wave ?? "none"} runs now`
              : `Slice ${sliceId} waits for a decision: ${decision.reason}`,
            {
              sliceId,
              status: slice.status,
              wave: slice.wave,
              current: progress.wave,
              ...(decision === undefined ? {} : { reason: decision.reason }),
            },
          );
        }
        const escalations = await escalationsOf(mission.id);
        if (escalations.length > 0) {
          throw new OrchestratorError(
            "ESCALATION_OPEN",
            `The lead asked the owner and waits for the answer: no slice is handed meanwhile`,
            { missionId: mission.id, escalations },
          );
        }
        const step = slice.step ?? mission.process.slice[0]?.id;
        // A2's agents.send delivers it: an agent's current generation (its first is
        // started then, D606), queued while it works; the owner's inbox. The id is
        // the slice as it was planned, so a retry delivers it once.
        const { delivery } = await run<{ delivery?: { threadId: string } }>(
          "agents.send",
          {
            to: slice.assignee,
            messageId: `handoff-${slice.id}-${slice.updatedAt}`,
            body: cut(
              [
                handoffText({
                  slice,
                  mission,
                  intent: state.intents[mission.projectId]?.intent,
                  step,
                }),
                // A review slice gets the project to review against (D1246).
                ...(slice.reviews === undefined || slice.reviews.length === 0
                  ? []
                  : [(await reviewBrief(slice)).markdown]),
              ].join("\n"),
              MAX_MESSAGE_LENGTH,
              `review_brief { sliceId: "${slice.id}" }`,
            ),
          },
          invocation,
        );
        const threadId = agent === undefined ? undefined : delivery?.threadId;
        if (threadId !== undefined) await run("slices.link", { sliceId, threadId }, invocation);
        const updated = await run<Slice>(
          "slices.update",
          { sliceId, status: "active", ...(step === undefined ? {} : { step }) },
          invocation,
        );
        return {
          slice: updated,
          delivered: agent === undefined ? ("owner" as const) : ("agent" as const),
          ...(threadId === undefined ? {} : { threadId }),
          handed: true,
        };
      },
    });

    // --- Review after the last change (D1241) -------------------------------------
    /** Whether taking `step` needs the mission's work reviewed after its last change. */
    const needsReview = (mission: Mission, step: string) =>
      config().reviewSteps.includes(step) ||
      mission.process.mission.some((candidate) => candidate.id === step && candidate.review);
    /** The reviewed files read again (`git.tree`, as the node): a path that cannot be read is left out. */
    const checkReviews = async (mission: Mission) => {
      const slices = slicesOf(state, mission.id);
      const trees = new Map<string, string>();
      for (const work of reviewedWork(slices)) {
        try {
          const now = await run<{ tree: string }>(
            "git.tree",
            work.threadId === undefined
              ? { projectId: work.projectId }
              : { threadId: work.threadId },
          );
          trees.set(work.path, now.tree);
        } catch (error) {
          context.log.warn("A reviewed slice's files could not be read", {
            missionId: mission.id,
            path: work.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return reviewCheck(slices, trees);
    };
    context.commands.register({
      name: "missions.review.check",
      description:
        "Whether every done slice of a mission was reviewed after its last change (its files are still those its latest review saw), and, with a step, whether that step needs it: a step that needs a review is refused until this is clear",
      input: z.object({ missionId: z.string(), step: z.string().optional() }),
      output: ReviewCheck.extend({
        /** Whether `step` needs a review; true without a step. */
        needed: z.boolean(),
      }),
      permissions: ["missions.read"],
      handler: async ({ missionId, step }) => {
        await sync();
        const mission = getMission(missionId);
        return {
          needed: step === undefined || needsReview(mission, step),
          ...(await checkReviews(mission)),
        };
      },
    });
    // The missions plugin runs this hook before a mission takes a step of its own process.
    context.subscriptions.add(
      context.hooks.before<{ mission: Mission; step: string }>(MISSION_STEP_HOOK, async (input) => {
        if (!needsReview(input.mission, input.step)) return input;
        await sync();
        const check = await checkReviews(input.mission);
        if (check.clear) return input;
        throw new OrchestratorError(
          "REVIEW_REQUIRED",
          `Step ${input.step} of mission ${input.mission.id} needs a review after the last change: ${check.unreviewed
            .map((item) => `${state.slices[item.sliceId]?.title ?? item.sliceId} (${item.reason})`)
            .join(", ")}. Have the slices reviewed again (slices.review), then take the step`,
          { missionId: input.mission.id, step: input.step, unreviewed: check.unreviewed },
        );
      }),
    );

    // --- The orchestrator workflow (D706) ----------------------------------------
    context.commands.register({
      name: "missions.orchestrate",
      description:
        "Runs the orchestrator workflow for a mission from the calling thread (its lead): it hands each ready slice of the current wave to its assignee, waits for their proofs, moves on, and ends with what the lead must decide or run, which wakes the thread. A mission already being orchestrated returns its running workflow. Running it again goes on from where the mission is",
      input: z.object({
        missionId: z.string(),
        parentThreadId: z.string().min(1).optional(),
        /** How long each wait for the mission to move lasts before it looks again. */
        waitMs: z.number().int().min(1).max(MAX_WAIT_MS).optional(),
      }),
      output: z.object({
        workflowId: z.string(),
        name: z.string(),
        status: z.string(),
        /** True when the mission's orchestrator was already running. */
        existing: z.boolean(),
      }),
      permissions: ["missions.write", "threads.write"],
      handler: async ({ missionId, parentThreadId: named, waitMs }, invocation) => {
        const parentThreadId = named ?? invocation.threadId;
        if (parentThreadId === undefined) {
          throw new OrchestratorError(
            "THREAD_REQUIRED",
            "missions.orchestrate runs from a thread: call it from the lead's thread or pass parentThreadId",
          );
        }
        if (
          named !== undefined &&
          invocation.threadId !== undefined &&
          named !== invocation.threadId
        ) {
          throw new OrchestratorError(
            "THREAD_REQUIRED",
            `parentThreadId ${named} is not the calling thread ${invocation.threadId}`,
          );
        }
        await sync();
        const mission = getMission(missionId);
        if (mission.status === "done" || mission.status === "dropped") {
          throw new OrchestratorError(
            "MISSION_CLOSED",
            `Mission ${missionId} is ${mission.status}`,
            {
              missionId,
            },
          );
        }
        const key = `run/${missionId}`;
        const last = (await kv.get(NAMESPACE, key)) as { workflowId?: string } | undefined;
        if (last?.workflowId !== undefined) {
          const runs = await run<{ workflowId: string; name: string; status: string }[]>(
            "workflows.list",
            {},
          );
          const running = runs.find(
            (item) => item.workflowId === last.workflowId && item.status === "running",
          );
          if (running !== undefined) {
            return {
              workflowId: running.workflowId,
              name: running.name,
              status: running.status,
              existing: true,
            };
          }
        }
        // The script is this plugin's own and its only argument a mission id, so
        // the caller may start it without holding workflows.run itself; its
        // command() calls still run with the caller's own grants (D706).
        const caller = invocation.caller;
        const actsFrom =
          invocation.threadId ??
          (caller === undefined || caller.permissions.includes("*") ? parentThreadId : undefined);
        const started = await run<{ workflowId: string; name: string; status: string }>(
          "workflows.run",
          {
            script: ORCHESTRATOR_WORKFLOW,
            args: { missionId, ...(waitMs === undefined ? {} : { waitMs }) },
            parentThreadId,
          },
          {
            ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
            // The run's command() calls act from the lead's thread, so a handoff
            // is sent as the lead, not as the owner (D1106). A caller without a
            // thread acts for the thread it names only if it may act for anyone.
            ...(actsFrom === undefined ? {} : { threadId: actsFrom }),
            ...(caller === undefined
              ? {}
              : { caller: { id: caller.id, permissions: [...caller.permissions, WORKFLOWS_RUN] } }),
          },
        );
        // The thread it runs from is the mission's lead (D1222), and the run's end is the mission's.
        await kv.set(NAMESPACE, key, { workflowId: started.workflowId, parentThreadId });
        await kv.set(NAMESPACE, `workflow/${started.workflowId}`, { missionId });
        return { ...started, existing: false };
      },
    });

    // --- Closing a mission with the lead's word for the owner (D1222) -------------
    context.commands.register({
      name: "missions.close",
      description:
        "Closes a mission as done or dropped, with what the lead says was committed or merged and where: the owner gets the lead's report with the mission, its slices and their proof",
      input: z.object({
        missionId: z.string(),
        status: z.enum(["done", "dropped"]),
        summary: z
          .string()
          .max(8000)
          .optional()
          .meta({ description: "What was committed or merged, and where; what is left" }),
      }),
      output: Mission,
      permissions: ["missions.write"],
      handler: async ({ missionId, status, summary }, invocation) => {
        await sync();
        const mission = getMission(missionId);
        if (isClosed(mission.status)) {
          throw new OrchestratorError(
            "MISSION_CLOSED",
            `Mission ${missionId} is ${mission.status}`,
            {
              missionId,
            },
          );
        }
        if (summary !== undefined && summary.trim() !== "") {
          // Before the update: its event reports at once and reads it (D1222).
          await kv.set(NAMESPACE, `summary/${missionId}`, summary);
        }
        try {
          return await run<Mission>("missions.update", { missionId, status }, invocation);
        } catch (error) {
          await kv.delete(NAMESPACE, `summary/${missionId}`);
          throw error;
        }
      },
    });

    // --- A mission's run, for the owner's client (C2: D1086) ----------------------
    context.commands.register({
      name: "missions.orchestration",
      description:
        "The orchestrator run of a mission, the last one missions.orchestrate started: its workflow, the thread it runs from, its status, last log lines and result. With the head of the `orchestration` stream it reflects, to follow the run from there",
      input: z.object({ missionId: z.string() }),
      output: z.object({
        /** The `orchestration` stream's head, read before the run: follow it after this. */
        head: z.number(),
        run: OrchestratorRun.nullable(),
      }),
      permissions: ["missions.read", "threads.read"],
      handler: async ({ missionId }) => {
        await sync();
        getMission(missionId);
        const streamHead = await log.head(ORCHESTRATION_STREAM);
        const last = (await kv.get(NAMESPACE, `run/${missionId}`)) as
          | { workflowId?: string }
          | undefined;
        if (last?.workflowId === undefined) return { head: streamHead, run: null };
        const runs = await run<z.input<typeof OrchestratorRun>[]>("workflows.list", {});
        const found = runs.find((item) => item.workflowId === last.workflowId);
        if (found === undefined) return { head: streamHead, run: null };
        const view = OrchestratorRun.parse(found);
        return { head: streamHead, run: { ...view, logs: view.logs.slice(-5) } };
      },
    });

    // --- Refocus (D708–D711) -----------------------------------------------------
    /** The open slice a thread of this node works on, changed last (as `missions.chain` picks it). */
    const sliceOfThread = (threadId: string, threadNode?: string) =>
      Object.values(state.slices)
        .filter((slice) =>
          slice.threads.some(
            (thread) =>
              thread.threadId === threadId &&
              (threadNode === undefined || (thread.nodeId ?? nodeId) === threadNode),
          ),
        )
        .toSorted(
          (a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt.localeCompare(a.updatedAt),
        )[0];

    async function brief(
      target: { sliceId: string } | { threadId: string; nodeId?: string | undefined },
      reason: RefocusReason,
    ) {
      await sync();
      const slice =
        "sliceId" in target
          ? getSlice(target.sliceId)
          : sliceOfThread(target.threadId, target.nodeId);
      if (slice === undefined) {
        throw new OrchestratorError(
          "SLICE_NOT_FOUND",
          `No slice links thread ${"threadId" in target ? target.threadId : ""}`,
          target,
        );
      }
      const chain = intentChain(state, slice.id);
      if (chain === undefined)
        throw new OrchestratorError("SLICE_NOT_FOUND", `No slice ${slice.id}`);
      let markdown = refocusText(chain, reason);
      // After a compaction the lore comes back too (A4's deferred brief, D671).
      if (reason === "compaction" && "threadId" in target && (target.nodeId ?? nodeId) === nodeId) {
        markdown += await loreAfterCompaction(target.threadId);
      }
      return { markdown, chain };
    }
    const loreAfterCompaction = async (threadId: string) => {
      try {
        const { thread } = await getThread(threadId);
        const lore = await run<{ markdown: string; stories: string[] }>("lore.brief", {
          projectId: thread.projectId,
          ...(thread.generationOf === undefined ? {} : { agent: thread.generationOf }),
          reason: "compaction",
        });
        return lore.stories.length === 0 ? "" : `\n---\n\n${lore.markdown}`;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "COMMAND_NOT_FOUND") {
          context.log.warn("no lore brief for a refocus", { threadId, error: String(error) });
        }
        return "";
      }
    };

    const Reason = z.enum(["request", "compaction", "interval"]).default("request");
    context.commands.register({
      name: "refocus.brief",
      description:
        "The refocus brief of a slice, or of the slice a thread works on (nodeId: only that node's thread): its intent chain, slice spec → mission outcome → project intent, and the question whether the work serves it",
      input: z.union([
        z.object({ sliceId: z.string(), reason: Reason }),
        z.object({ threadId: z.string(), nodeId: z.string().optional(), reason: Reason }),
      ]),
      output: z.object({ markdown: z.string(), chain: IntentChain }),
      permissions: ["missions.read"],
      handler: ({ reason, ...target }) => brief(target, reason),
    });

    /**
     * Hands a thread of this node its brief: into the running turn when its
     * agent steers, else as the next message of its queue (D710).
     */
    async function refocus(threadId: string, reason: RefocusReason, invocation?: Invocation) {
      const { markdown } = await brief({ threadId, nodeId }, reason);
      const { thread, running } = await getThread(threadId);
      const agentId = thread.lastTurn?.agentId ?? thread.agentId;
      const agents = await run<{ agentId: string; steering?: boolean }[]>("agents.list", {});
      const steers = agents.find((agent) => agent.agentId === agentId)?.steering === true;
      const messageId = `refocus-${Crypto.randomUUID()}`;
      if (running !== undefined && steers) {
        const sent = await run<{ outcome: string }>(
          "threads.steer",
          { threadId, messageId, text: markdown },
          invocation,
        );
        return { messageId, outcome: sent.outcome };
      }
      const sent = await run<{ turnId?: string }>(
        "threads.queue.add",
        { threadId, messageId, text: markdown },
        invocation,
      );
      return { messageId, outcome: sent.turnId === undefined ? "queued" : "started" };
    }

    context.commands.register({
      name: "refocus.send",
      description:
        "Hands a thread of this node the refocus brief of the slice it works on: steered into its running turn when its agent can take it, else queued as its next message",
      input: z.object({ threadId: z.string(), reason: Reason }),
      output: z.object({
        messageId: z.string(),
        outcome: z.enum(["steered", "started", "queued"]),
      }),
      permissions: ["missions.read", "threads.write"],
      handler: async ({ threadId, reason }, invocation) => {
        const sent = await refocus(threadId, reason, invocation);
        return sent as { messageId: string; outcome: "steered" | "started" | "queued" };
      },
    });

    // --- When refocus comes by itself (D710, D711) -------------------------------
    /** The threads of this node working on open slices, followed for compactions and turns. */
    const watched = new Map<string, Disposable>();
    /** One refocus at a time per thread, and its turn count kept in order. */
    const lanes = new Map<string, Promise<unknown>>();
    const inLane = (threadId: string, work: () => Promise<unknown>) => {
      const next = (lanes.get(threadId) ?? Promise.resolve()).then(work).catch((error: unknown) => {
        if (!disposed) context.log.warn("refocus failed", { threadId, error: String(error) });
      });
      lanes.set(threadId, next);
      return next;
    };
    const onThreadEvent = (threadId: string, event: StoredEvent) => {
      if (disposed) return;
      if (event.type === ThreadEvents.contextCompacted) {
        if (!config().refocusOnCompaction) return;
        void inLane(threadId, async () => {
          await kv.set(NAMESPACE, `turns/${threadId}`, 0);
          await refocus(threadId, "compaction");
        });
      } else if (event.type === ThreadEvents.turnStarted) {
        const every = config().refocusEveryTurns;
        if (every === 0) return;
        void inLane(threadId, async () => {
          const turns =
            (((await kv.get(NAMESPACE, `turns/${threadId}`)) as number | undefined) ?? 0) + 1;
          if (turns < every) {
            await kv.set(NAMESPACE, `turns/${threadId}`, turns);
            return;
          }
          await kv.set(NAMESPACE, `turns/${threadId}`, 0);
          await refocus(threadId, "interval");
        });
      }
    };
    function watchThreads() {
      if (disposed) return;
      const wanted = new Set<string>();
      for (const slice of Object.values(state.slices)) {
        if (!isOpen(slice)) continue;
        for (const thread of slice.threads) {
          if (thread.nodeId === undefined || thread.nodeId === nodeId) wanted.add(thread.threadId);
        }
      }
      for (const [threadId, subscription] of watched) {
        if (wanted.has(threadId)) continue;
        subscription.dispose();
        watched.delete(threadId);
      }
      for (const threadId of wanted) {
        if (watched.has(threadId)) continue;
        watched.set(
          threadId,
          log.subscribe(threadStream(threadId), (event) => onThreadEvent(threadId, event)),
        );
      }
    }
    context.subscriptions.add({
      dispose: () => {
        for (const subscription of watched.values()) subscription.dispose();
        watched.clear();
      },
    });

    await sync();
    caughtUp = true;
  },
});
