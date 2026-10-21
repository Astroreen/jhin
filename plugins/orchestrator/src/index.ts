import * as Crypto from "node:crypto";

import { ThreadEvents, parseAgentAddress, threadStream } from "@jhin/agent-api";
import { HOST_IDENTITY_CAPABILITY, type HostIdentity } from "@jhin/host-api";
import {
  EMPTY_MISSIONS,
  IntentChain,
  MISSIONS_STREAM,
  Mission,
  MissionProgress,
  Slice,
  Step,
  applyMissionEvent,
  intentChain,
  missionProgress,
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
  | "THREAD_REQUIRED";

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
    const apply = (events: readonly StoredEvent[]) => {
      for (const event of events) {
        if (event.sequence <= head) continue;
        state = applyMissionEvent(state, event);
        head = event.sequence;
        for (const listener of changed) listener(event);
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

    // --- Handing a slice to its assignee (D703) --------------------------------
    context.commands.register({
      name: "slices.handoff",
      description:
        "Hands a ready slice to its assignee: an agent of this node gets it as a message in its current generation (the first one is started when it has none), which is linked to the slice; the owner's slice is only marked active. The slice becomes active at its process's first step. Handing an active slice again changes nothing",
      input: z.object({ sliceId: z.string() }),
      output: z.object({
        slice: Slice,
        delivered: z.enum(["agent", "owner"]),
        threadId: z.string().optional(),
        /** False when the slice was already handed. */
        handed: z.boolean(),
      }),
      permissions: ["missions.write", "threads.write"],
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
              `${slice.assignee} is on another node: hand it over with agents.send (A2)`,
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
        const step = slice.step ?? mission.process.slice[0]?.id;
        let threadId: string | undefined;
        if (agent !== undefined) {
          // The agent's current generation takes its work (D606); its first is started here.
          // Seam: A2's agents.send { to, from, body } delivers this once it lands.
          const generations = await run<{ threadId: string; current: boolean }[]>(
            "agents.generations",
            { agentId: agent.agentId },
          );
          threadId =
            generations.find((generation) => generation.current)?.threadId ??
            (
              await run<{ generation: { threadId: string } }>("agents.rotate", {
                agentId: agent.agentId,
                reason: `Slice ${slice.title}`,
              })
            ).generation.threadId;
          await run(
            "threads.queue.add",
            {
              threadId,
              messageId: `handoff-${Crypto.randomUUID()}`,
              text: handoffText({
                slice,
                mission,
                intent: state.intents[mission.projectId]?.intent,
                step,
                from: invocation.caller?.id,
              }),
            },
            invocation,
          );
          await run("slices.link", { sliceId, threadId }, invocation);
        }
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
        const started = await run<{ workflowId: string; name: string; status: string }>(
          "workflows.run",
          {
            script: ORCHESTRATOR_WORKFLOW,
            args: { missionId, ...(waitMs === undefined ? {} : { waitMs }) },
            parentThreadId,
          },
          {
            ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
            ...(caller === undefined
              ? {}
              : { caller: { id: caller.id, permissions: [...caller.permissions, WORKFLOWS_RUN] } }),
          },
        );
        await kv.set(NAMESPACE, key, { workflowId: started.workflowId });
        return { ...started, existing: false };
      },
    });

    // --- Refocus (D708–D711) -----------------------------------------------------
    const getThread = async (threadId: string) => {
      const { thread, running } = await run<{ thread: unknown; running?: string }>("threads.get", {
        threadId,
      });
      return { thread: ThreadView.parse(thread), running };
    };
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
  },
});
