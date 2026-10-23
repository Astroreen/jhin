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
  MAX_ANSWER_LENGTH,
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
import { LIVE_STREAMS_CAPABILITY, UNGUARDED_STREAM_PERMISSION, type LiveStreams } from "@jhin/rpc";
import {
  definePlugin,
  describePermissions,
  missingPermissions,
  z,
  type Disposable,
  type Invocation,
} from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog, type Json, type StoredEvent } from "@jhin/storage-api";

import { mergeByTime } from "./merge.ts";
import { Sensors, broaderThanNarrower, type Finding } from "./sensors.ts";

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
    /** Health's asks delivered on this node, by message id, until their first reply or the dismissal of their warning. */
    const asksDelivered = new Map<string, { warningId: string; to: string }>();
    /** Where each warning's dismissal stands in the `health` stream. */
    const dismissedAtHead = new Map<string, number>();
    const applyHealth = (events: readonly StoredEvent[]) => {
      for (const event of events) {
        if (event.stream !== HEALTH_STREAM || event.sequence <= healthHead) continue;
        health = applyHealthEvent(health, event);
        healthHead = event.sequence;
        if (
          event.type === HealthEvents.ideaCorrected ||
          event.type === HealthEvents.ideaWithdrawn
        ) {
          sensors.setIdeas(Object.values(health.ideas));
        } else if (event.type === HealthEvents.progressRecorded) {
          const progress = (event.payload as { progress?: Progress }).progress;
          if (progress !== undefined) sensors.ingestProgress(progress, event);
        } else if (event.type === HealthEvents.warningDismissed) {
          // A dismissed warning's asks wait for no reply any more.
          const warningId = (event.payload as { warningId?: string } | null)?.warningId;
          if (warningId !== undefined) dismissedAtHead.set(warningId, event.sequence);
          for (const [messageId, ask] of asksDelivered) {
            if (ask.warningId === warningId) asksDelivered.delete(messageId);
          }
        }
      }
    };

    /** Appends to `health` one at a time, so the fold never misses its own events. */
    let appending: Promise<unknown> = Promise.resolve();
    const append = (type: string, payload: unknown): Promise<void> =>
      appendIf(() => ({ type, payload }));
    /**
     * Appends what `decide` returns, if anything, deciding on the fold as it is
     * right before the write: a check and its write are one step, in turn with
     * every other append.
     */
    function appendIf(decide: () => { type: string; payload: unknown } | undefined) {
      const run = async () => {
        applyHealth(await log.read(HEALTH_STREAM, { after: healthHead }));
        const next = decide();
        if (next === undefined) return;
        applyHealth(
          await log.append(HEALTH_STREAM, [{ type: next.type, payload: next.payload as Json }]),
        );
      };
      const result = appending.then(run, run);
      appending = result.catch(() => undefined);
      return result;
    }

    // --- Following the log ---------------------------------------------------------
    interface Source {
      readonly stream: string;
      readonly handle: (event: StoredEvent) => void;
    }
    const heads = new Map<string, number>();
    /** The subscription of every stream followed, so a thread no slice links is left. */
    const followed = new Map<string, Disposable>();
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
      const fresh = sources.filter((source) => !followed.has(source.stream));
      if (fresh.length === 0) return undefined;
      let waiting: { source: Source; event: StoredEvent }[] | undefined = [];
      const subscriptions = fresh.map((source) => {
        const subscription = context.subscriptions.add(
          log.subscribe(source.stream, (event) => {
            if (waiting === undefined) {
              deliver(source, event);
              evaluateSoon();
            } else waiting.push({ source, event });
          }),
        );
        followed.set(source.stream, subscription);
        return subscription;
      });
      try {
        const read = await Promise.all(
          fresh.map(async (source) =>
            // A stream followed before (a thread linked again) goes on from
            // where it was left: what was counted is not counted twice.
            (await log.read(source.stream, { after: heads.get(source.stream) ?? 0 })).map(
              (event) => ({ source, event }),
            ),
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
        for (const source of fresh) followed.delete(source.stream);
        context.log.warn("health could not read a stream", {
          streams: fresh.map((source) => source.stream),
          error: String(error),
        });
        return error;
      }
    };
    /** A thread a slice links is followed for its approvals and queue (D722). */
    const followThreads = () => {
      const linked = sensors.linkedThreads();
      // A thread no slice links any more (unlinked, its slice gone) is left.
      for (const [stream, subscription] of followed) {
        if (!stream.startsWith("thread/") || linked.has(stream.slice("thread/".length))) continue;
        subscription.dispose();
        followed.delete(stream);
      }
      const sources = [...linked]
        .filter((threadId) => !followed.has(threadStream(threadId)))
        .map((threadId) => ({
          stream: threadStream(threadId),
          handle: (event: StoredEvent) => sensors.ingestThread(threadId, event),
        }));
      if (sources.length === 0) return;
      // What a newly followed thread replays is counted: the detectors run after
      // it, once it was read (a stream that failed waits for the next run).
      void follow(sources).then((error) => {
        if (error === undefined) evaluateSoon();
      });
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
    const raise = async (finding: Finding, evaluatedAt: number) => {
      const warning: Warning = {
        warningId: Crypto.randomUUID(),
        ...finding,
        raisedAt: now(),
        status: "open",
      };
      let raised = false;
      // Decided on the fold right before the write, in turn with every append:
      // a dismissal that lands meanwhile is seen.
      await appendIf(() => {
        // The latest warning of this detector and subject decides.
        const earlier = Object.values(health.warnings)
          .filter(
            (other) => other.detector === finding.detector && other.subject === finding.subject,
          )
          .reduce<Warning | undefined>(
            (latest, other) =>
              latest === undefined || other.raisedAt > latest.raisedAt ? other : latest,
            undefined,
          );
        if (earlier?.status === "open") return undefined;
        // Found before a dismissal of its subject was recorded: it counted what
        // the dismissal set aside, so the run after the dismissal decides again.
        // Positions in the stream, not clock time: one millisecond may hold both.
        const dismissedAt =
          earlier === undefined ? undefined : dismissedAtHead.get(earlier.warningId);
        if (dismissedAt !== undefined && dismissedAt > evaluatedAt) return undefined;
        raised = true;
        return { type: HealthEvents.warningRaised, payload: { warning } };
      });
      if (!raised) return;
      context.events.emit(HealthEvents.warningRaised, { warning });
      void analyse(warning);
    };

    /**
     * Closes an open warning whose measure is back under its threshold. Decided
     * on the fold right before the write: two runs, or a dismissal meanwhile,
     * make one exit (D1283). The analysis stays; the analyst is not asked again.
     */
    const clear = (
      warningId: string,
      why: { reason: string; narrowerWarningId?: string } = { reason: "under-threshold" },
    ) =>
      appendIf(() =>
        health.warnings[warningId]?.status !== "open" ||
        // A narrower warning that was dismissed or cleared meanwhile speaks for nothing.
        (why.narrowerWarningId !== undefined &&
          health.warnings[why.narrowerWarningId]?.status !== "open")
          ? undefined
          : {
              type: HealthEvents.warningCleared,
              payload: { warningId, clearedAt: now(), ...why },
            },
      ).catch((error: unknown) =>
        context.log.warn("a warning could not be cleared", { warningId, error: String(error) }),
      );

    /**
     * The agent that has the context (D726): the analyst configured for the
     * project, else the team's lead (A5, not landed: the seam), else the agent
     * assigned most of the group's open and done slices. Never a random agent.
     */
    const analystOf = async (
      warning: Warning,
    ): Promise<{ address: string; reason: string } | undefined> => {
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
      if (tally.size === 0) return undefined;
      // The team's lead (D726): of the teams the group's assignees belong to, the
      // one holding most of the group's slices, when teams are offered (A5).
      const lead = await teamLead(tally);
      if (lead !== undefined) return { address: lead, reason: "team-lead" };
      // Else the agent assigned most slices; a tie goes to the address first in order.
      const [best] = [...tally].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return best === undefined ? undefined : { address: best[0], reason: "assignee" };
    };
    /** The lead of the team holding most of the tallied assignees' slices, if any. */
    const teamLead = async (tally: ReadonlyMap<string, number>): Promise<string | undefined> => {
      if (!context.commands.list().some((command) => command.name === "teams.list")) {
        return undefined;
      }
      let teams: { teamId: string; members: { address: string; lead: boolean }[] }[];
      try {
        ({ teams } = (await context.commands.execute("teams.list", {})) as { teams: typeof teams });
      } catch (error) {
        context.log.warn("teams could not be read for a warning's analyst", {
          error: String(error),
        });
        return undefined;
      }
      const ranked = teams
        .map((team) => ({
          team,
          slices: team.members.reduce((sum, member) => sum + (tally.get(member.address) ?? 0), 0),
          lead: team.members.find((member) => member.lead)?.address,
        }))
        .filter((entry) => entry.slices > 0 && entry.lead !== undefined)
        .toSorted((a, b) => b.slices - a.slices || a.team.teamId.localeCompare(b.team.teamId));
      return ranked[0]?.lead;
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
      // One ask at a time per warning; asked again meanwhile, it is looked at
      // once more when this one ends (a config change naming an analyst).
      if (asking.has(warning.warningId)) {
        lookAgain.add(warning.warningId);
        return;
      }
      asking.add(warning.warningId);
      try {
        await analyseOnce(warning);
      } finally {
        asking.delete(warning.warningId);
      }
      if (lookAgain.delete(warning.warningId)) {
        const current = health.warnings[warning.warningId];
        const unasked = current?.analysis === undefined || current.analysis.status === "none";
        if (current?.status === "open" && unasked) void analyse(current);
      }
    };
    /** Warnings whose analyst is being asked now, and those asked again meanwhile. */
    const asking = new Set<string>();
    const lookAgain = new Set<string>();
    const analyseOnce = async (warning: Warning) => {
      await asksReady;
      // Health turned off asks nobody, also for warnings raised before.
      if (!config().enabled) return;
      const analyst = await analystOf(warning);
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
              timers.set(timer, () => reject(new Error("health deactivated")));
            }),
          ])) as { status: string; answer?: string };
          if (result.status !== "answered") {
            throw new Error(`the ask is ${result.status}, not answered`);
          }
          analysis = {
            status: "answered",
            analyst: analyst.address,
            reason: analyst.reason,
            ...(result.answer === undefined
              ? {}
              : {
                  answer:
                    result.answer.length > MAX_ANSWER_LENGTH
                      ? `${result.answer.slice(0, MAX_ANSWER_LENGTH)}…`
                      : result.answer,
                }),
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

    /** The timeouts of asks under way, with what ends the wait for each. */
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    /** Detectors run after the events of a tick, one run at a time. */
    let evaluating: Promise<void> = Promise.resolve();
    let scheduled = false;
    let active = true;
    const evaluate = async () => {
      const current = config();
      if (!current.enabled || !active) return;
      // A linked thread that could not be read is tried again on every run.
      followThreads();
      // Warnings whose measure dropped back are cleared first, so a subject
      // that crossed again in the same run raises a new one (D1283).
      for (const warning of sensors.clearable(current, health, Date.now())) {
        await clear(warning.warningId);
      }
      // The health stream's head the findings were made against.
      const evaluatedAt = healthHead;
      for (const finding of sensors.evaluate(current, health, Date.now())) {
        await raise(finding, evaluatedAt);
      }
      // One cause, one warning: a broader group's open warning closes once a
      // narrower group's speaks for it (D1284). If the broader group still
      // crosses after the narrower one is gone, it raises anew.
      for (const { warning, narrower } of broaderThanNarrower(health)) {
        await clear(warning.warningId, {
          reason: "narrower",
          narrowerWarningId: narrower.warningId,
        });
      }
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
      // An ask that never answers leaves no timer, and no waiting analysis,
      // behind a reload: each wait ends now and records nothing (not active).
      for (const [timer, end] of timers) {
        clearTimeout(timer);
        end();
      }
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
      // Only a reply to an ask health really delivered, and only its first
      // reply: an id the sender merely writes into `inReplyTo` excludes nothing.
      // The analyst is whom that ask went to, whatever the config says now.
      const ask =
        message?.inReplyTo === undefined ? undefined : asksDelivered.get(message.inReplyTo);
      if (ask === undefined || message?.from !== ask.to) return false;
      asksDelivered.delete(message!.inReplyTo!);
      return true;
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
          if (asked !== undefined) {
            askedBefore.add(asked);
            const delivered = (
              event.payload as { message?: { messageId?: string; to?: string } } | null
            )?.message;
            if (delivered?.messageId !== undefined && delivered.to !== undefined) {
              asksDelivered.set(delivered.messageId, { warningId: asked, to: delivered.to });
              // The analyst of a mind virus traces the idea: its quotes of the
              // phrase are that work, not the idea coming back.
              const subject = health.warnings[asked]?.subject;
              if (subject?.startsWith("idea:") === true) {
                sensors.addTracer(subject.slice("idea:".length), delivered.to);
              }
            }
          } else if (!analystReply(event)) sensors.ingestMessage(event);
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
      // Health turned off asks nobody and records nothing (D725).
      if (!config().enabled) return;
      for (const warning of warningsOf(health)) {
        // Unanalysed, or analysed by nobody: a config change may name an analyst now.
        const unasked = warning.analysis === undefined || warning.analysis.status === "none";
        if (warning.status !== "open" || !unasked) continue;
        // An ask under way is no ask cut short: it is looked at again once it ends.
        if (asking.has(warning.warningId)) {
          lookAgain.add(warning.warningId);
          continue;
        }
        if (!askedBefore.has(warning.warningId)) {
          void analyse(warning);
          continue;
        }
        // Whom that ask went to, as it was delivered.
        const to = [...asksDelivered.values()].find(
          (ask) => ask.warningId === warning.warningId,
        )?.to;
        const analyst = to === undefined ? undefined : { address: to, reason: "asked" };
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
    // Health turned on, or an analyst named: open warnings nobody analysed are asked.
    // New thresholds, or health turned on, are evaluated at once, not on the next event.
    context.subscriptions.add(
      context.config.onDidChange(HEALTH_CONFIG_SECTION, () => {
        askAgain();
        evaluateSoon();
      }),
    );

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
      // Only a thread a slice links by the turn's end makes progress of a mission.
      if (sensors.slicesOfThread(input.threadId).length === 0) {
        context.events.emit(COMMITS_COUNTED_EVENT, { turnId: input.turnId, count });
        return;
      }
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
          // Every turn's start is read: its thread may be linked to a slice
          // during the turn (the usual order for a fresh thread); whether it
          // counts is decided at its end.
          if (config().enabled) {
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
        status: z.enum(["open", "dismissed", "cleared", "all"]).default("open"),
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
            // A record is read with what its own stream takes, as the plugin
            // that owns it guards it (security.md D415): health.read is no way
            // around agents.read, missions.read or threads.read.
            const needed = live?.guardOf?.(ref.stream) ?? [UNGUARDED_STREAM_PERMISSION];
            const missing = grants === undefined ? [] : missingPermissions(grants, needed);
            if (missing.length > 0) {
              return { ...ref, payload: null, withheld: missing.join(", ") };
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
        getWarning(warningId);
        // An exact cut for counting again (D724): the log's own head of every
        // stream health follows now, also of events not delivered to it yet. A
        // stream not followed now (a thread unlinked) counts from the time.
        const dismissedAfter = Object.fromEntries(
          await Promise.all(
            [...new Set([...followed.keys(), HEALTH_STREAM])].map(
              async (stream) => [stream, await log.head(stream)] as const,
            ),
          ),
        );
        // Decided on the fold right before the write: two dismissals make one.
        await appendIf(() =>
          getWarning(warningId).status !== "open"
            ? undefined
            : {
                type: HealthEvents.warningDismissed,
                payload: { warningId, dismissedAt: now(), dismissedAfter, ...by(invocation) },
              },
        );
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
        // A project named is checked against projects.list when a plugin offers it.
        if (
          projectId !== undefined &&
          context.commands.list().some((c) => c.name === "projects.list")
        ) {
          const projects = (await context.commands.execute("projects.list", {})) as {
            id: string;
          }[];
          if (!projects.some((project) => project.id === projectId)) {
            throw new HealthError("PROJECT_NOT_FOUND", `No project ${projectId}`, { projectId });
          }
        }
        // The same phrase corrected again for the same project is the same idea,
        // checked in the same step as the write, so two calls make one idea.
        const same = (other: Idea) =>
          normalizeIdea(other.idea) === normalizeIdea(idea) && other.projectId === projectId;
        const record: Idea = {
          ideaId: Crypto.randomUUID(),
          idea,
          ...(correction === undefined ? {} : { correction }),
          ...(projectId === undefined ? {} : { projectId }),
          ...by(invocation),
          correctedAt: now(),
        };
        let known: Idea | undefined;
        await appendIf(() => {
          known = Object.values(health.ideas).find(same);
          return known === undefined
            ? { type: HealthEvents.ideaCorrected, payload: { idea: record } }
            : undefined;
        });
        return known ?? record;
      },
    });
    context.commands.register({
      name: "health.ideas.withdraw",
      description:
        "Withdraws a corrected idea named by mistake: health no longer watches for it, and its open mind-virus warning stays as it is",
      input: z.object({ ideaId: z.string() }),
      output: z.object({ ideaId: z.string() }),
      ...write,
      handler: async ({ ideaId }, invocation) => {
        await sync();
        if (health.ideas[ideaId] === undefined) {
          throw new HealthError("IDEA_NOT_FOUND", `No idea ${ideaId}`, { ideaId });
        }
        await append(HealthEvents.ideaWithdrawn, { ideaId, ...by(invocation) });
        return { ideaId };
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
