// The sensors of health (docs/plans/agents.md, A7: D722–D727): what the event
// log says about ceremony and progress, per mission, per project and for the
// node, and the detectors that turn it into warnings. Pure: the plugin feeds it
// events and appends what `evaluate` returns.
import {
  ThreadEvents,
  parseMessageAddress,
  type AgentMessage,
  type MessageDelivery,
} from "@jhin/agent-api";
import {
  MAX_EVIDENCE,
  groupKey,
  isCeremony,
  carriesIdea,
  normalizeIdea,
  type Detector,
  type EventRef,
  type HealthConfig,
  type HealthGroup,
  type HealthState,
  type Idea,
  type Progress,
  type SignalKind,
  type Warning,
} from "@jhin/health-api";
import {
  EMPTY_MISSIONS,
  MissionEvents,
  applyMissionEvent,
  type MissionsState,
  type Slice,
} from "@jhin/missions-api";
import { OWNER_PRINCIPAL_ID, clientPrincipalId } from "@jhin/auth-api";
import { SourceControlEvents } from "@jhin/source-control-api";
import type { StoredEvent } from "@jhin/storage-api";

/** One counted event: ceremony or progress, and the groups it counts in. */
interface Signal {
  readonly kind: SignalKind;
  readonly ref: EventRef;
  readonly time: number;
  /** Group keys, `node` always among them. */
  readonly groups: readonly string[];
}

/** A warning a detector would raise; the plugin gives it an id and checks it is new (D724). */
export interface Finding {
  readonly detector: Detector;
  readonly subject: string;
  readonly group: HealthGroup;
  readonly summary: string;
  readonly measures: Record<string, number>;
  readonly evidence: EventRef[];
}

const refOf = (event: StoredEvent, kind?: SignalKind): EventRef => ({
  stream: event.stream,
  sequence: event.sequence,
  type: event.type,
  at: event.at,
  ...(kind === undefined ? {} : { kind }),
});

const OPEN: ReadonlySet<Slice["status"]> = new Set(["planned", "active", "blocked"]);

export class Sensors {
  missions: MissionsState = EMPTY_MISSIONS;
  private signals: Signal[] = [];
  private readonly groups = new Map<string, HealthGroup>([["node", { kind: "node" }]]);
  /** Proofs recorded on a slice already done, by slice id (D726). */
  private readonly proofEdits = new Map<string, EventRef[]>();
  /** Where a corrected idea came back, by idea id: the event and who carried it (D727). */
  private readonly occurrences = new Map<string, { ref: EventRef; carrier: string }[]>();
  private ideas: readonly Idea[] = [];
  /** Merged pull requests counted, by thread and pull request. */
  private readonly merges = new Map<string, number>();

  /** The slices a thread works on (D647), so its events count for their missions. */
  slicesOfThread(threadId: string): Slice[] {
    return Object.values(this.missions.slices).filter((slice) =>
      slice.threads.some((thread) => thread.threadId === threadId),
    );
  }

  /** Every thread a slice links, for the plugin to follow. */
  linkedThreads(): Set<string> {
    const threads = new Set<string>();
    for (const slice of Object.values(this.missions.slices)) {
      for (const thread of slice.threads) threads.add(thread.threadId);
    }
    return threads;
  }

  /** The corrected ideas, given before the events they should be found in. */
  setIdeas(ideas: readonly Idea[]): void {
    this.ideas = ideas;
  }

  private groupsOf(slices: readonly Slice[]): string[] {
    const keys = new Set(["node"]);
    for (const slice of slices) {
      const title = this.missions.missions[slice.missionId]?.title;
      const mission: HealthGroup = {
        kind: "mission",
        projectId: slice.projectId,
        missionId: slice.missionId,
        ...(title === undefined ? {} : { title }),
      };
      const project: HealthGroup = { kind: "project", projectId: slice.projectId };
      for (const group of [mission, project]) {
        const key = groupKey(group);
        this.groups.set(key, group);
        keys.add(key);
      }
    }
    return [...keys];
  }

  private count(
    kind: SignalKind,
    event: StoredEvent,
    slices: readonly Slice[],
    time = Date.parse(event.at),
  ): void {
    this.signals.push({
      kind,
      ref: refOf(event, kind),
      time,
      groups: this.groupsOf(slices),
    });
  }

  /** Who health asked to trace an idea, by idea id: quoting it is their work (D727). */
  private readonly tracers = new Map<string, Set<string>>();

  /** An agent health asked to trace where an idea came from. */
  addTracer(ideaId: string, address: string): void {
    const known = this.tracers.get(ideaId) ?? new Set<string>();
    known.add(address);
    this.tracers.set(ideaId, known);
  }

  /** An idea's phrase in a text written after the correction, by someone other than the owner. */
  private findIdeas(event: StoredEvent, text: string, carrier: string, slices: readonly Slice[]) {
    if (this.ideas.length === 0) return;
    const haystack = normalizeIdea(text);
    for (const idea of this.ideas) {
      if (this.tracers.get(idea.ideaId)?.has(carrier) === true) continue;
      if (Date.parse(event.at) < Date.parse(idea.correctedAt)) continue;
      if (idea.projectId !== undefined && !slices.some((s) => s.projectId === idea.projectId))
        continue;
      if (!carriesIdea(haystack, normalizeIdea(idea.idea))) continue;
      const list = this.occurrences.get(idea.ideaId) ?? [];
      list.push({ ref: refOf(event), carrier });
      this.occurrences.set(idea.ideaId, list);
    }
  }

  /**
   * An event of the `missions` stream (D642): slices done, proof edits, specs
   * carrying an idea. Returns whether a slice's threads changed, so the plugin
   * follows new ones.
   */
  ingestMission(event: StoredEvent): boolean {
    const slice = (event.payload as { slice?: Slice } | null)?.slice;
    const before = slice === undefined ? undefined : this.missions.slices[slice.id];
    this.missions = applyMissionEvent(this.missions, event);
    if (slice === undefined) return false;
    if (event.type === MissionEvents.sliceReviewed) {
      // A review recorded (L2, D1242): a check on the work, so ceremony (L3, D1265).
      this.count("review", event, [slice]);
    } else if (event.type === MissionEvents.sliceProved && before?.status === "done") {
      // A proof recorded again on a done slice: ceremony, and the loop's evidence.
      this.count("proof-edit", event, [slice]);
      const edits = this.proofEdits.get(slice.id) ?? [];
      edits.push(refOf(event, "proof-edit"));
      this.proofEdits.set(slice.id, edits);
    } else if (slice.status === "done" && before?.status !== "done") {
      this.count("slice-done", event, [slice]);
    }
    if (event.type === MissionEvents.sliceCreated || event.type === MissionEvents.sliceUpdated) {
      const by = (event.payload as { by?: string }).by;
      // The owner, or one of the owner's devices, writing the phrase (a "do not
      // do X" note) is the correction, not a carrier; so is the node itself.
      // auth-api names the owner's devices: `client:<id>` (security.md D411).
      const owners =
        by === undefined || by === OWNER_PRINCIPAL_ID || by.startsWith(clientPrincipalId(""));
      if (
        !owners &&
        (before === undefined || before.spec !== slice.spec || before.title !== slice.title)
      ) {
        this.findIdeas(event, `${slice.title}\n${slice.spec}`, by, [slice]);
      }
    }
    const threads = (value: Slice | undefined) =>
      (value?.threads ?? []).map((thread) => thread.threadId).join("|");
    return threads(before) !== threads(slice);
  }

  /**
   * A message delivered on this node (D627). It counts for the missions of the
   * thread it went to; else for one slice: the open slice of its recipient,
   * else of its sender, changed last (a message is one piece of work, so it
   * is not multiplied over every mission of an agent); otherwise only for the
   * node. Attribution is the state when the event is read, which a restart
   * reproduces, since the streams are replayed in time order.
   */
  ingestMessage(event: StoredEvent): void {
    const payload = event.payload as { message?: AgentMessage; delivery?: MessageDelivery } | null;
    const message = payload?.message;
    if (message === undefined) return;
    let slices =
      payload?.delivery === undefined ? [] : this.slicesOfThread(payload.delivery.threadId);
    if (slices.length === 0) {
      const assigned = (address: string) =>
        Object.values(this.missions.slices)
          .filter((slice) => OPEN.has(slice.status) && slice.assignee === address)
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const [slice] = [...assigned(message.to), ...assigned(message.from)];
      slices = slice === undefined ? [] : [slice];
    }
    this.count(message.kind, event, slices);
    if (parseMessageAddress(message.from)?.kind !== "owner") {
      this.findIdeas(event, message.body, message.from, slices);
    }
  }

  /** An event of a slice's thread: approvals asked and queue changes are ceremony. */
  ingestThread(threadId: string, event: StoredEvent): void {
    const payload = event.payload as { request?: { kind?: string } } | null;
    const kind: SignalKind | undefined =
      event.type === ThreadEvents.queueUpdated
        ? "queue"
        : event.type === ThreadEvents.requestOpened && payload?.request?.kind === "approval"
          ? "approval"
          : undefined;
    if (kind !== undefined) this.count(kind, event, this.slicesOfThread(threadId));
  }

  /**
   * A pull request of a slice's thread that merged, from the `source-control`
   * stream (`git.pr.linked`, `git.pr.updated`): progress once per thread and
   * pull request (D723).
   */
  ingestSourceControl(event: StoredEvent): void {
    if (
      event.type !== SourceControlEvents.pullRequestLinked &&
      event.type !== SourceControlEvents.pullRequestUpdated
    )
      return;
    const payload = event.payload as {
      threadId?: string;
      pullRequest?: { key?: string; snapshot?: { state?: string; mergedAt?: string } | null };
    } | null;
    const threadId = payload?.threadId;
    const key = payload?.pullRequest?.key;
    if (threadId === undefined || key === undefined) return;
    if (payload?.pullRequest?.snapshot?.state !== "merged") return;
    const merge = `${threadId}|${key}`;
    if (this.merges.has(merge)) return;
    // A merge counts at the time it merged, not when its snapshot was published
    // again: a merge already out of the window is out of it however late it is told.
    const mergedAt = Date.parse(payload?.pullRequest?.snapshot?.mergedAt ?? event.at);
    const time = Number.isNaN(mergedAt) ? Date.parse(event.at) : mergedAt;
    this.merges.set(merge, time);
    this.count("merge", event, this.slicesOfThread(threadId), time);
  }

  /** Commits recorded on the `health` stream (D723). */
  ingestProgress(progress: Progress, event: StoredEvent): void {
    // A turn that commits is one piece of progress, however many commits it
    // made: a rebase or an import is no more progress, and empty commits buy
    // no room under the ceremony threshold (D723).
    this.count(progress.kind, event, this.slicesOfThread(progress.threadId));
  }

  /** Counts per group of the signals in the window that `keep` keeps for that group. */
  private tally(keep: (key: string, ref: EventRef) => boolean = () => true) {
    const byGroup = new Map<
      string,
      { ceremony: number; progress: number; byKind: Record<string, number>; refs: EventRef[] }
    >();
    for (const signal of this.signals) {
      for (const key of signal.groups) {
        if (!keep(key, signal.ref)) continue;
        const entry = byGroup.get(key) ?? { ceremony: 0, progress: 0, byKind: {}, refs: [] };
        if (isCeremony(signal.kind)) entry.ceremony += 1;
        else entry.progress += 1;
        entry.byKind[signal.kind] = (entry.byKind[signal.kind] ?? 0) + 1;
        // One event counted twice (commits of one turn) is one piece of evidence.
        if (
          entry.refs.at(-1)?.stream !== signal.ref.stream ||
          entry.refs.at(-1)?.sequence !== signal.ref.sequence
        )
          entry.refs.push(signal.ref);
        byGroup.set(key, entry);
      }
    }
    return [...byGroup].map(([key, entry]) => ({ key, group: this.groups.get(key)!, ...entry }));
  }

  /** Ceremony and progress of every group over the window, by kind. */
  status(config: HealthConfig, now: number) {
    this.prune(config, now);
    return this.tally();
  }

  /** Forgets what left the window. */
  private prune(config: HealthConfig, now: number): void {
    const start = now - config.windowHours * 3_600_000;
    // Not in time order: a thread followed later replays its older events after newer ones.
    if (this.signals.some((signal) => signal.time < start)) {
      this.signals = this.signals.filter((signal) => signal.time >= start);
    }
    const inWindow = (ref: EventRef) => Date.parse(ref.at) >= start;
    for (const [sliceId, edits] of this.proofEdits) {
      const kept = edits.filter(inWindow);
      if (kept.length === 0) this.proofEdits.delete(sliceId);
      else if (kept.length !== edits.length) this.proofEdits.set(sliceId, kept);
    }
    // A merge out of the window is forgotten too; its pull request is settled.
    for (const [merge, time] of this.merges) if (time < start) this.merges.delete(merge);
    for (const [ideaId, found] of this.occurrences) {
      const kept = found.filter((occurrence) => inWindow(occurrence.ref));
      if (kept.length === 0) this.occurrences.delete(ideaId);
      else if (kept.length !== found.length) this.occurrences.set(ideaId, kept);
    }
  }

  /**
   * The open warnings whose detector no longer finds its subject at or over
   * its own threshold (D1383). Only the detector's own measure decides: a
   * broader group kept quiet by a narrower one still crosses, so stays open.
   */
  clearable(config: HealthConfig, health: HealthState, now: number): Warning[] {
    this.prune(config, now);
    const over = new Set<string>();
    const { ratio, minCeremony } = config.ceremony;
    for (const entry of this.tally()) {
      if (entry.ceremony >= Math.max(minCeremony, ratio * Math.max(entry.progress, 1))) {
        over.add(`ceremony|${entry.key}`);
      }
    }
    for (const [sliceId, edits] of this.proofEdits) {
      if (edits.length >= config.proofLoop.maxEdits) over.add(`proof-loop|slice:${sliceId}`);
    }
    for (const [ideaId, found] of this.occurrences) {
      if (found.length >= config.mindVirus.minOccurrences) over.add(`mind-virus|idea:${ideaId}`);
    }
    return Object.values(health.warnings).filter(
      (warning) =>
        warning.status === "open" &&
        !over.has(`${warning.detector}|${warning.subject}`) &&
        // A withdrawn idea or a forgotten slice is not a measure dropping.
        !(
          warning.detector === "mind-virus" && health.ideas[warning.subject.slice(5)] === undefined
        ),
    );
  }

  /**
   * What every detector finds now (D724, D727, D728). Every detector counts
   * over the window; a dismissal starts the count of its subject again, so
   * the same subject warns again only when what came after the dismissal
   * alone crosses the threshold.
   */
  evaluate(config: HealthConfig, health: HealthState, now: number): Finding[] {
    this.prune(config, now);
    // The latest warning of a subject decides: open waits, dismissed resets.
    const latest = new Map<string, Warning>();
    for (const warning of Object.values(health.warnings)) {
      const key = `${warning.detector}|${warning.subject}`;
      const known = latest.get(key);
      if (known === undefined || known.raisedAt < warning.raisedAt) latest.set(key, warning);
    }
    /**
     * What a subject counts: after a dismissal, only the events past the last
     * one of each stream the dismissal saw (`dismissedAfter`), an exact cut
     * where the clock's milliseconds are not.
     */
    const after = (detector: Detector, subject: string): ((ref: EventRef) => boolean) => {
      const warning = latest.get(`${detector}|${subject}`);
      if (warning?.status !== "dismissed" && warning?.status !== "cleared") return () => true;
      // A clear has no stream positions: its events count from its time (D1383).
      const seen = warning.status === "dismissed" ? warning.dismissedAfter : undefined;
      const since = Date.parse(
        (warning.status === "dismissed" ? warning.dismissedAt : warning.clearedAt) ??
          warning.raisedAt,
      );
      // A stream the dismissal did not follow yet (a thread linked later) has
      // no cut: its events count from the dismissal's time.
      return (ref) => {
        const cut = seen?.[ref.stream];
        return cut === undefined ? Date.parse(ref.at) >= since : ref.sequence > cut;
      };
    };

    const findings: Finding[] = [];
    // Ceremony against progress, per group (D722). The narrowest group that
    // crosses warns. Its project and the node stay quiet while it crosses over
    // the window, dismissed or not, so one cause makes one warning (D724).
    const { ratio, minCeremony } = config.ceremony;
    const limitOf = (progress: number) => Math.max(minCeremony, ratio * Math.max(progress, 1));
    const quiet = new Set<string>();
    for (const entry of this.tally()) {
      if (entry.group.kind === "node" || entry.ceremony < limitOf(entry.progress)) continue;
      quiet.add("node");
      if (entry.group.kind === "mission") {
        quiet.add(groupKey({ kind: "project", projectId: entry.group.projectId }));
      }
    }
    // One rule per group, made once per run, not per signal.
    const rules = new Map<string, (ref: EventRef) => boolean>();
    const rule = (key: string) => {
      let made = rules.get(key);
      if (made === undefined) {
        made = after("ceremony", key);
        rules.set(key, made);
      }
      return made;
    };
    for (const entry of this.tally((key, ref) => rule(key)(ref))) {
      const limit = limitOf(entry.progress);
      if (entry.ceremony < limit || quiet.has(entry.key)) continue;
      findings.push({
        detector: "ceremony",
        subject: entry.key,
        group: entry.group,
        summary: `${entry.ceremony} ceremony against ${entry.progress} progress in ${config.windowHours}h (warns at ${limit})`,
        measures: { ceremony: entry.ceremony, progress: entry.progress, threshold: limit },
        evidence: entry.refs.slice(-MAX_EVIDENCE),
      });
    }
    // Recursive proof loops: a done slice's proof recorded again and again (D728).
    for (const [sliceId, all] of this.proofEdits) {
      const subject = `slice:${sliceId}`;
      const edits = all.filter(after("proof-loop", subject));
      if (edits.length < config.proofLoop.maxEdits) continue;
      const slice = this.missions.slices[sliceId];
      if (slice === undefined) continue;
      const title = this.missions.missions[slice.missionId]?.title;
      findings.push({
        detector: "proof-loop",
        subject,
        group: {
          kind: "mission",
          projectId: slice.projectId,
          missionId: slice.missionId,
          ...(title === undefined ? {} : { title }),
        },
        summary: `The proof of done slice "${slice.title}" was recorded again ${edits.length} times`,
        measures: { edits: edits.length, threshold: config.proofLoop.maxEdits },
        evidence: edits.slice(-MAX_EVIDENCE),
      });
    }
    // Mind virus: a corrected idea coming back (D727).
    for (const [ideaId, all] of this.occurrences) {
      const subject = `idea:${ideaId}`;
      const idea = health.ideas[ideaId];
      const keep = after("mind-virus", subject);
      const found = all.filter((occurrence) => keep(occurrence.ref));
      if (idea === undefined || found.length < config.mindVirus.minOccurrences) continue;
      const carriers = [...new Set(found.map((occurrence) => occurrence.carrier))];
      findings.push({
        detector: "mind-virus",
        subject,
        group:
          idea.projectId === undefined
            ? { kind: "node" }
            : { kind: "project", projectId: idea.projectId },
        summary: `The corrected idea "${idea.idea}" came back ${found.length} times, carried by ${carriers.join(", ")}`,
        measures: {
          occurrences: found.length,
          carriers: carriers.length,
          threshold: config.mindVirus.minOccurrences,
        },
        evidence: found.map((occurrence) => occurrence.ref).slice(-MAX_EVIDENCE),
      });
    }
    return findings;
  }
}
