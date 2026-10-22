import { execFile } from "node:child_process";
import * as Crypto from "node:crypto";

import {
  MESSAGES_STREAM,
  MessageEvents,
  ThreadHooks,
  parseMessageAddress,
  threadStream,
  type TurnEndHookInput,
  type TurnHookInput,
} from "@jhin/agent-api";
import {
  EMPTY_HEALTH,
  EventRef,
  GroupStatus,
  HEALTH_CONFIG_SECTION,
  HEALTH_READ_PERMISSION,
  HEALTH_STREAM,
  HEALTH_WRITE_PERMISSION,
  COMMITS_COUNTED_EVENT,
  HealthConfig,
  HealthEvents,
  Idea,
  MIN_IDEA_WORDS,
  normalizeIdea,
  Warning,
  applyHealthEvent,
  warningsOf,
  type Analysis,
  type HealthErrorCode,
  type HealthState,
  type Progress,
} from "@jhin/health-api";
import { MISSIONS_STREAM } from "@jhin/missions-api";
import { SOURCE_CONTROL_STREAM } from "@jhin/source-control-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import { definePlugin, describePermissions, holdsPermission, z, type Invocation } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog, type Json, type StoredEvent } from "@jhin/storage-api";

import { mergeByTime } from "./merge.ts";
import { Sensors, type Finding } from "./sensors.ts";

export { HEALTH_STREAM };

/**
 * Health's own asks to an analyst (D725) have the id `health.<warningId>.<time>` (the ask's time in ms);
 * they are no ceremony. An id only counts as health's when it names a warning
 * health raised before it, whose random id nobody else knows in advance.
 */
const OWN_ASK = /^health\.([0-9a-f-]{36})\.\d+$/;

class HealthError extends Error {
  readonly code: HealthErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: HealthErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** `git` in a directory, or `undefined` when it fails: health never fails a turn (D723). */
function git(cwd: string, args: string[], timeout = 5_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout }, (error, stdout) =>
      resolve(error === null ? stdout.trim() : undefined),
    );
  });
}

/** What reading a stream behind a warning takes, as its own plugin guards it. */
function streamPermission(stream: string): string | undefined {
  if (stream === MISSIONS_STREAM) return "missions.read";
  if (stream === MESSAGES_STREAM) return "agents.read";
  if (stream === SOURCE_CONTROL_STREAM) return "git.read";
  if (stream === HEALTH_STREAM) return HEALTH_READ_PERMISSION;
  if (stream.startsWith("thread/")) return "threads.read";
  return undefined;
}

export default definePlugin({
  async activate(context) {
    const log = context.services.get<EventLog>(EVENTLOG_CAPABILITY);
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    if (live?.guard !== undefined) {
      context.subscriptions.add(live.guard(HEALTH_STREAM, [HEALTH_READ_PERMISSION]));
    }
    context.subscriptions.add(context.config.define(HEALTH_CONFIG_SECTION, HealthConfig));
    let lastGood = HealthConfig.parse({});
    const config = (): HealthConfig => {
      try {
        lastGood = context.config.get<HealthConfig>(HEALTH_CONFIG_SECTION);
      } catch {
        // An invalid layer keeps the last good thresholds until it is fixed.
      }
      return lastGood;
    };
    const now = () => new Date().toISOString();

    // --- State: the fold of `health`, and the sensors over the other streams ----
    let health: HealthState = EMPTY_HEALTH;
    let healthHead = 0;
    const sensors = new Sensors();
    const applyHealth = (events: readonly StoredEvent[]) => {
      for (const event of events) {
        if (event.stream !== HEALTH_STREAM || event.sequence <= healthHead) continue;
        health = applyHealthEvent(health, event);
        healthHead = event.sequence;
        if (event.type === HealthEvents.ideaCorrected) {
          sensors.setIdeas(Object.values(health.ideas));
        } else if (event.type === HealthEvents.progressRecorded) {
          const progress = (event.payload as { progress?: Progress }).progress;
          if (progress !== undefined) sensors.ingestProgress(progress, event);
        }
      }
    };

    /** Appends to `health` one at a time, so the fold never misses its own events. */
    let appending: Promise<unknown> = Promise.resolve();
    const append = (type: string, payload: unknown): Promise<void> => {
      const run = async () => {
        applyHealth(await log.read(HEALTH_STREAM, { after: healthHead }));
        applyHealth(await log.append(HEALTH_STREAM, [{ type, payload: payload as Json }]));
      };
      const result = appending.then(run, run);
      appending = result.catch(() => undefined);
      return result;
    };

    // --- Following the log ---------------------------------------------------------
    interface Source {
      readonly stream: string;
      readonly handle: (event: StoredEvent) => void;
    }
    const heads = new Map<string, number>();
    const deliver = ({ stream, handle }: Source, event: StoredEvent) => {
      if (event.sequence <= (heads.get(stream) ?? 0)) return;
      heads.set(stream, event.sequence);
      try {
        handle(event);
      } catch (error) {
        context.log.warn("a health sensor failed on an event", {
          stream,
          sequence: event.sequence,
          error: String(error),
        });
      }
    };
    /**
     * Follows streams from their start, then every event appended to them.
     * What they hold is replayed merged in time order, so every event is
     * attributed with the missions as they were then, on a restart as live
     * (D722). Events that arrive while they are read wait, so none is handled
     * twice or skipped. A stream that cannot be read is logged and left
     * unfollowed, so the next try reads it again; returns the error, if any.
     */
    const follow = async (sources: readonly Source[]): Promise<unknown> => {
      const fresh = sources.filter((source) => !heads.has(source.stream));
      if (fresh.length === 0) return undefined;
      for (const source of fresh) heads.set(source.stream, 0);
      let waiting: { source: Source; event: StoredEvent }[] | undefined = [];
      const subscriptions = fresh.map((source) =>
        context.subscriptions.add(
          log.subscribe(source.stream, (event) => {
            if (waiting === undefined) {
              deliver(source, event);
              evaluateSoon();
            } else waiting.push({ source, event });
          }),
        ),
      );
      try {
        const read = await Promise.all(
          fresh.map(async (source) =>
            (await log.read(source.stream)).map((event) => ({ source, event })),
          ),
        );
        for (const { source, event } of mergeByTime(
          read.map((events) => events.map((item) => ({ ...item, at: item.event.at }))),
        )) {
          deliver(source, event);
        }
        const held = waiting;
        waiting = undefined;
        for (const { source, event } of held) deliver(source, event);
        return undefined;
      } catch (error) {
        waiting = undefined;
        for (const subscription of subscriptions) subscription.dispose();
        for (const source of fresh) heads.delete(source.stream);
        context.log.warn("health could not read a stream", {
          streams: fresh.map((source) => source.stream),
          error: String(error),
        });
        return error;
      }
    };
    /** A thread a slice links is followed for its approvals and queue (D722). */
    const followThreads = () => {
      const sources = [...sensors.linkedThreads()].map((threadId) => ({
        stream: threadStream(threadId),
        handle: (event: StoredEvent) => sensors.ingestThread(threadId, event),
      }));
      void follow(sources);
    };

    /**
     * Resolves once `agents.ask` can take an ask: at once when it is already
     * registered (health enabled on a running node, a plugin reload), else
     * when a plugin activating brings it, or when the node has started (an ask
     * then fails if no plugin offers it, and is recorded so).
     */
    const asksReady = new Promise<void>((resolve) => {
      const askable = () =>
        context.commands.list().some((command) => command.name === "agents.ask");
      if (askable() || context.state.get<boolean>("kernelStarted") === true) return resolve();
      const done = () => {
        activated.dispose();
        started.dispose();
        resolve();
      };
      const activated = context.subscriptions.add(
        context.events.on("kernel.plugin.activated", () => {
          if (askable()) done();
        }),
      );
      const started = context.subscriptions.add(
        context.events.on("kernel.started", () => {
          context.state.set("kernelStarted", true);
          done();
        }),
      );
    });

    // --- Warnings --------------------------------------------------------------------
    /**
     * Raises what is new: one open warning per detector and subject (D724);
     * after a dismissal the sensors count only what came since (`evaluate`).
     */
    const raise = async (finding: Finding) => {
      const earlier = warningsOf(health).find(
        (warning) => warning.detector === finding.detector && warning.subject === finding.subject,
      );
      if (earlier?.status === "open") return;
      const warning: Warning = {
        warningId: Crypto.randomUUID(),
        ...finding,
        raisedAt: now(),
        status: "open",
      };
      await append(HealthEvents.warningRaised, { warning });
      context.events.emit(HealthEvents.warningRaised, { warning });
      void analyse(warning);
    };

    /**
     * The agent that has the context (D726): the analyst configured for the
     * project, else the team's lead (A5, not landed: the seam), else the agent
     * assigned most of the group's open and done slices. Never a random agent.
     */
    const analystOf = (warning: Warning): { address: string; reason: string } | undefined => {
      const { analysts } = config();
      const projectId =
        warning.group.kind === "project" || warning.group.kind === "mission"
          ? warning.group.projectId
          : undefined;
      const configured =
        (projectId === undefined ? undefined : analysts[projectId]) ?? analysts["*"];
      // Only an agent analyses: the owner is told anyway, and an ask to the
      // owner only waits in the inbox (D626).
      if (configured !== undefined && parseMessageAddress(configured)?.kind === "agent") {
        return { address: configured, reason: "config" };
      }
      if (configured !== undefined) {
        context.log.warn("a configured analyst is not an agent's address", { configured });
      }
      if (projectId === undefined) return undefined;
      const tally = new Map<string, number>();
      for (const slice of Object.values(sensors.missions.slices)) {
        if (slice.projectId !== projectId || slice.status === "dropped") continue;
        if (warning.group.kind === "mission" && slice.missionId !== warning.group.missionId)
          continue;
        if (slice.assignee === undefined || parseMessageAddress(slice.assignee)?.kind !== "agent")
          continue;
        tally.set(slice.assignee, (tally.get(slice.assignee) ?? 0) + 1);
      }
      // Most slices first; a tie goes to the address first in order, never to chance.
      const [best] = [...tally].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return best === undefined ? undefined : { address: best[0], reason: "assignee" };
    };

    const question = (warning: Warning) =>
      [
        `Health warning ${warning.warningId} (${warning.detector}) on ${JSON.stringify(warning.group)}:`,
        warning.summary,
        "",
        `Measures: ${JSON.stringify(warning.measures)}`,
        "Events behind it (stream#sequence type at):",
        ...warning.evidence
          .slice(-20)
          .map((ref) => `- ${ref.stream}#${ref.sequence} ${ref.type} ${ref.at}`),
        "",
        warning.detector === "mind-virus"
          ? "A corrected idea came back. Trace where it was written down and which agents carry it, and say which copies to fix (docs/lore/mind-viruses.md)."
          : "You have this work's context. Say why ceremony outgrows progress here and what to stop doing; do not add process (docs/lore/bureaucracy.md).",
      ].join("\n");

    /**
     * Asks the analyst (D725), for at most `analysisTimeoutMinutes`. An ask
     * still running when the plugin deactivates records nothing; the next
     * activation asks again for every open warning without an analysis.
     */
    const analyse = async (warning: Warning) => {
      await asksReady;
      // Health turned off asks nobody, also for warnings raised before.
      if (!config().enabled) return;
      const analyst = analystOf(warning);
      let analysis: Analysis;
      if (analyst === undefined) {
        analysis = { status: "none", at: now() };
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const forget = () => {
          clearTimeout(timer);
          if (timer !== undefined) timers.delete(timer);
        };
        try {
          const minutes = config().analysisTimeoutMinutes;
          const result = (await Promise.race([
            context.commands.execute("agents.ask", {
              to: analyst.address,
              question: question(warning),
              messageId: `health.${warning.warningId}.${Date.now()}`,
            }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`no answer within ${minutes} minutes`)),
                minutes * 60_000,
              );
              timers.add(timer);
            }),
          ])) as { status: string; answer?: string };
          if (result.status !== "answered") {
            throw new Error(`the ask is ${result.status}, not answered`);
          }
          analysis = {
            status: "answered",
            analyst: analyst.address,
            reason: analyst.reason,
            ...(result.answer === undefined ? {} : { answer: result.answer }),
            at: now(),
          };
        } catch (error) {
          analysis = {
            status: "failed",
            analyst: analyst.address,
            reason: analyst.reason,
            error: error instanceof Error ? error.message : String(error),
            at: now(),
          };
        } finally {
          forget();
        }
      }
      if (!active) return;
      await append(HealthEvents.warningAnalysed, { warningId: warning.warningId, analysis }).catch(
        (error: unknown) =>
          context.log.warn("a warning's analysis could not be recorded", {
            warningId: warning.warningId,
            error: String(error),
          }),
      );
    };

    /** The timeouts of asks under way, cleared on deactivation. */
    const timers = new Set<ReturnType<typeof setTimeout>>();
    /** Detectors run after the events of a tick, one run at a time. */
    let evaluating: Promise<void> = Promise.resolve();
    let scheduled = false;
    let active = true;
    const evaluate = async () => {
      const current = config();
      if (!current.enabled || !active) return;
      for (const finding of sensors.evaluate(current, health, Date.now())) await raise(finding);
    };
    function evaluateSoon() {
      if (scheduled) return;
      scheduled = true;
      evaluating = evaluating.then(async () => {
        scheduled = false;
        await evaluate().catch((error: unknown) =>
          context.log.warn("health detectors failed", { error: String(error) }),
        );
      });
    }
    context.onDeactivate(async () => {
      active = false;
      // An ask that never answers leaves no timer behind a reload.
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await evaluating;
      // Commits being counted finish before the plugin goes (git calls are bounded).
      await Promise.all(countings);
    });
    /** Commit counts under way, finished on deactivation. */
    const countings = new Set<Promise<void>>();

    /**
     * A message the analyst of a warning sent in reply to health's ask about
     * it: health's own conversation, no ceremony, and not a carrier of the
     * idea it was asked to trace (D725, D727).
     */
    const analystReply = (event: StoredEvent): boolean => {
      const message = (
        event.payload as {
          message?: { inReplyTo?: string; from?: string };
        } | null
      )?.message;
      const warningId =
        message?.inReplyTo === undefined ? undefined : OWN_ASK.exec(message.inReplyTo)?.[1];
      const warning = warningId === undefined ? undefined : health.warnings[warningId];
      if (warning === undefined) return false;
      const analyst = warning.analysis?.analyst ?? analystOf(warning)?.address;
      return analyst !== undefined && message?.from === analyst;
    };
    /** The warnings health already asked about, from the delivered asks (D725). */
    const askedBefore = new Set<string>();
    /** The warning a delivered message is health's own ask about, if it is one. */
    const ownAsk = (event: StoredEvent): string | undefined => {
      const payload = event.payload as {
        message?: { messageId?: string; kind?: string; from?: string };
        delivery?: { nodeId?: string };
      } | null;
      const message = payload?.message;
      const warningId =
        message?.messageId === undefined ? undefined : OWN_ASK.exec(message.messageId)?.[1];
      if (warningId === undefined || health.warnings[warningId] === undefined) return undefined;
      // Health asks as this node's owner (D725), whom an agent cannot send as
      // (D622): an agent that copies the id is still counted.
      const from = message?.from === undefined ? undefined : parseMessageAddress(message.from);
      const own =
        message?.kind === "ask" &&
        from?.kind === "owner" &&
        payload?.delivery?.nodeId !== undefined &&
        from.nodeId === payload.delivery.nodeId;
      return own ? warningId : undefined;
    };
    // Every stream at once, in time order: health first among equals, so an
    // idea corrected or a warning raised is known before the events after it.
    // Without them health would count nothing, silently: activation fails
    // instead, and the host reports it. Thread streams are tried again on the
    // next change of a slice's threads.
    const unread = await follow([
      { stream: HEALTH_STREAM, handle: (event) => applyHealth([event]) },
      {
        stream: MISSIONS_STREAM,
        handle: (event) => {
          if (sensors.ingestMission(event)) followThreads();
        },
      },
      {
        stream: MESSAGES_STREAM,
        handle: (event) => {
          if (event.type !== MessageEvents.delivered) return;
          const asked = ownAsk(event);
          if (asked !== undefined) askedBefore.add(asked);
          else if (!analystReply(event)) sensors.ingestMessage(event);
        },
      },
      { stream: SOURCE_CONTROL_STREAM, handle: (event) => sensors.ingestSourceControl(event) },
    ]);
    if (unread !== undefined) throw unread;
    followThreads();
    evaluateSoon();
    // An open warning without an analysis: never asked (asked now), or asked
    // and cut short by a deactivation. That ask reached the analyst and its
    // answer is in the analyst's thread; asking again would ask it twice.
    const askAgain = () => {
      for (const warning of warningsOf(health)) {
        if (warning.status !== "open" || warning.analysis !== undefined) continue;
        if (!askedBefore.has(warning.warningId)) {
          void analyse(warning);
          continue;
        }
        const analyst = analystOf(warning);
        void append(HealthEvents.warningAnalysed, {
          warningId: warning.warningId,
          analysis: {
            status: "failed",
            ...(analyst === undefined ? {} : { analyst: analyst.address, reason: analyst.reason }),
            error: "The ask was cut short by a restart; its answer is in the analyst's thread.",
            at: now(),
          } satisfies Analysis,
        }).catch((error: unknown) =>
          context.log.warn("a warning's analysis could not be recorded", { error: String(error) }),
        );
      }
    };
    askAgain();

    // --- Progress no stream holds: the commits of a turn (D723) ---------------------
    /** Where each running turn of a linked thread started, kept across a reload. */
    const STARTS = "turn-starts";
    type Starts = Record<string, { head: string; at: number }>;
    const DAY = 24 * 3_600_000;
    /**
     * The commits of an ended turn on top of where it started (D723), then the
     * kernel event `health.commits.counted { turnId, count }`, also for none.
     */
    const countCommits = async (input: TurnEndHookInput) => {
      const { [input.turnId]: start, ...rest } = context.state.get<Starts>(STARTS) ?? {};
      if (start === undefined) return;
      context.state.set(STARTS, rest);
      let count = 0;
      const head = await git(input.cwd, ["rev-parse", "HEAD"]);
      // Only commits on top of where the turn started: a reset, rebase or
      // switch to another branch is no progress of its own.
      if (
        head !== undefined &&
        head !== start.head &&
        (await git(input.cwd, ["merge-base", "--is-ancestor", start.head, head])) !== undefined
      ) {
        const counted = Number(
          await git(input.cwd, ["rev-list", "--count", "--first-parent", `${start.head}..${head}`]),
        );
        if (Number.isInteger(counted) && counted > 0) {
          count = counted;
          const progress: Progress = {
            kind: "commit",
            count,
            threadId: input.threadId,
            projectId: input.projectId,
            ref: head,
            at: now(),
          };
          await append(HealthEvents.progressRecorded, { progress });
          evaluateSoon();
        }
      }
      context.events.emit(COMMITS_COUNTED_EVENT, { turnId: input.turnId, count });
    };
    context.subscriptions.add(
      context.hooks.before<TurnHookInput>(ThreadHooks.turnStart, async (input) => {
        try {
          if (config().enabled && sensors.slicesOfThread(input.threadId).length > 0) {
            // One quick read before the agent starts; it never fails the turn.
            const head = await git(input.cwd, ["rev-parse", "HEAD"], 2_000);
            // A turn that never ended (its node crashed) is forgotten after a day.
            const starts = Object.fromEntries(
              Object.entries(context.state.get<Starts>(STARTS) ?? {}).filter(
                ([, start]) => Date.now() - start.at < DAY,
              ),
            );
            if (head !== undefined) starts[input.turnId] = { head, at: Date.now() };
            context.state.set(STARTS, starts);
          }
        } catch (error) {
          context.log.warn("a turn's start could not be recorded", { error: String(error) });
        }
        return input;
      }),
    );
    context.subscriptions.add(
      context.hooks.before<TurnEndHookInput>(ThreadHooks.turnEnd, (input) => {
        // Counted off the turn's path: the turn ends at once, whatever git does.
        const counting = countCommits(input)
          .catch((error: unknown) =>
            context.log.warn("commits could not be counted", { error: String(error) }),
          )
          .finally(() => countings.delete(counting));
        countings.add(counting);
        return input;
      }),
    );
    // --- Commands ------------------------------------------------------------------
    const read = { permissions: [HEALTH_READ_PERMISSION] } as const;
    const write = { permissions: [HEALTH_WRITE_PERMISSION] } as const;
    describePermissions(context, {
      [HEALTH_READ_PERMISSION]: {
        title: "View health",
        description: "Read ceremony and progress, health warnings and corrected ideas.",
      },
      [HEALTH_WRITE_PERMISSION]: {
        title: "Manage health",
        description: "Dismiss health warnings and name corrected ideas.",
      },
    });
    const sync = async () => applyHealth(await log.read(HEALTH_STREAM, { after: healthHead }));
    const getWarning = (warningId: string) => {
      const warning = health.warnings[warningId];
      if (warning === undefined)
        throw new HealthError("WARNING_NOT_FOUND", `No warning ${warningId}`, { warningId });
      return warning;
    };
    const by = (invocation: Invocation) =>
      invocation.caller === undefined ? {} : { by: invocation.caller.id };

    context.commands.register({
      name: "health.status",
      description:
        "Ceremony (messages, asks, approvals, proof edits, queue activity) against progress (slices done, commits, merged pull requests) over the window, per mission, per project and for the node",
      input: z.object({}),
      output: z.object({ windowHours: z.number(), groups: z.array(GroupStatus) }),
      ...read,
      handler: async () => {
        await sync();
        const current = config();
        return {
          windowHours: current.windowHours,
          groups: sensors
            .status(current, Date.now())
            .map(({ group, ceremony, progress, byKind }) => ({
              group,
              ceremony,
              progress,
              byKind,
            })),
        };
      },
    });
    context.commands.register({
      name: "health.catalog",
      description:
        "Every warning and corrected idea of this node, and the head of the `health` stream they reflect: follow the stream after `head` to keep them current",
      input: z.object({}),
      output: z.object({ head: z.number(), warnings: z.array(Warning), ideas: z.array(Idea) }),
      ...read,
      handler: async () => {
        await sync();
        return {
          head: healthHead,
          warnings: warningsOf(health),
          ideas: Object.values(health.ideas),
        };
      },
    });
    context.commands.register({
      name: "health.warnings.list",
      description: "Health warnings, newest first",
      input: z.object({
        status: z.enum(["open", "dismissed", "all"]).default("open"),
        projectId: z.string().optional(),
      }),
      output: z.array(Warning),
      ...read,
      handler: async ({ status, projectId }) => {
        await sync();
        return warningsOf(health).filter(
          (warning) =>
            (status === "all" || warning.status === status) &&
            (projectId === undefined ||
              ((warning.group.kind === "project" || warning.group.kind === "mission") &&
                warning.group.projectId === projectId)),
        );
      },
    });
    context.commands.register({
      name: "health.warnings.get",
      description: "A health warning with the events behind it, read back from the log",
      input: z.object({ warningId: z.string() }),
      output: z.object({
        warning: Warning,
        events: z.array(
          EventRef.extend({
            payload: z.unknown(),
            missing: z.boolean().optional(),
            /** The permission the caller lacks to read this event's stream; no payload then. */
            withheld: z.string().optional(),
          }),
        ),
      }),
      ...read,
      handler: async ({ warningId }, invocation) => {
        await sync();
        const warning = getWarning(warningId);
        const grants = invocation.caller?.permissions;
        const events = await Promise.all(
          warning.evidence.map(async (ref) => {
            // A record is read with what its own stream takes: health.read is
            // not a way around agents.read, missions.read or threads.read.
            const needed = streamPermission(ref.stream);
            if (
              grants !== undefined &&
              (needed === undefined || !holdsPermission(grants, needed))
            ) {
              return { ...ref, payload: null, withheld: needed ?? "*" };
            }
            const [event] = await log.read(ref.stream, { after: ref.sequence - 1, limit: 1 });
            // A trimmed stream (D496) keeps the reference, not the event.
            return event?.sequence === ref.sequence
              ? { ...ref, payload: event.payload }
              : { ...ref, payload: null, missing: true };
          }),
        );
        return { warning, events };
      },
    });
    context.commands.register({
      name: "health.warnings.dismiss",
      description:
        "Marks a health warning seen; the same detector warns about the same thing again only on newer evidence",
      input: z.object({ warningId: z.string() }),
      output: Warning,
      ...write,
      handler: async ({ warningId }, invocation) => {
        await sync();
        const warning = getWarning(warningId);
        if (warning.status === "dismissed") return warning;
        await append(HealthEvents.warningDismissed, {
          warningId,
          dismissedAt: now(),
          // What it saw: an exact cut for counting again (D724).
          // Health's own stream is ahead of its subscription: its fold knows best.
          dismissedAfter: { ...Object.fromEntries(heads), [HEALTH_STREAM]: healthHead },
          ...by(invocation),
        });
        return getWarning(warningId);
      },
    });
    context.commands.register({
      name: "health.ideas.correct",
      description:
        "Names a wrong idea that was corrected, by a phrase that carries it: when it comes back in messages or slice specs, health warns about a mind virus",
      input: z.object({
        idea: z
          .string()
          .trim()
          .max(500)
          .refine((idea) => normalizeIdea(idea).split(" ").length >= MIN_IDEA_WORDS, {
            message: `Name the idea by a phrase of ${MIN_IDEA_WORDS} words at least`,
          }),
        correction: z.string().max(2_000).optional(),
        projectId: z.string().optional(),
      }),
      output: Idea,
      ...write,
      handler: async ({ idea, correction, projectId }, invocation) => {
        const record: Idea = {
          ideaId: Crypto.randomUUID(),
          idea,
          ...(correction === undefined ? {} : { correction }),
          ...(projectId === undefined ? {} : { projectId }),
          ...by(invocation),
          correctedAt: now(),
        };
        await append(HealthEvents.ideaCorrected, { idea: record });
        return record;
      },
    });
    context.commands.register({
      name: "health.ideas.list",
      description: "The corrected ideas the mind-virus detector watches for",
      input: z.object({}),
      output: z.array(Idea),
      ...read,
      handler: async () => {
        await sync();
        return Object.values(health.ideas).toSorted((a, b) =>
          a.correctedAt.localeCompare(b.correctedAt),
        );
      },
    });
  },
});
