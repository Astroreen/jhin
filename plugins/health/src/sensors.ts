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
  normalizeIdea,
  type Detector,
  type EventRef,
  type HealthConfig,
  type HealthGroup,
  type HealthState,
  type Idea,
  type Progress,
  type SignalKind,
} from "@jhin/health-api";
import {
  EMPTY_MISSIONS,
  MissionEvents,
  applyMissionEvent,
  type MissionsState,
  type Slice,
} from "@jhin/missions-api";
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
  private readonly merges = new Set<string>();

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

  private count(kind: SignalKind, event: StoredEvent, slices: readonly Slice[]): void {
    this.signals.push({
      kind,
      ref: refOf(event, kind),
      time: Date.parse(event.at),
      groups: this.groupsOf(slices),
    });
  }

  /** An idea's phrase in a text written after the correction, by someone other than the owner. */
  private findIdeas(event: StoredEvent, text: string, carrier: string, slices: readonly Slice[]) {
    if (this.ideas.length === 0) return;
    const haystack = normalizeIdea(text);
    for (const idea of this.ideas) {
      if (event.at < idea.correctedAt) continue;
      if (idea.projectId !== undefined && !slices.some((s) => s.projectId === idea.projectId))
        continue;
      if (!haystack.includes(normalizeIdea(idea.idea))) continue;
      const list = this.occurrences.get(idea.ideaId) ?? [];
      list.push({ ref: refOf(event), carrier });
      this.occurrences.set(idea.ideaId, list);
    }
  }

  /** An event of the `missions` stream (D642): slices done, proof edits, specs carrying an idea. */
  ingestMission(event: StoredEvent): void {
    const slice = (event.payload as { slice?: Slice } | null)?.slice;
    const before = slice === undefined ? undefined : this.missions.slices[slice.id];
    this.missions = applyMissionEvent(this.missions, event);
    if (slice === undefined) return;
    if (event.type === MissionEvents.sliceProved && before?.status === "done") {
      // A proof recorded again on a done slice: ceremony, and the loop's evidence.
      this.count("proof-edit", event, [slice]);
      const edits = this.proofEdits.get(slice.id) ?? [];
      edits.push(refOf(event, "proof-edit"));
      this.proofEdits.set(slice.id, edits);
    } else if (slice.status === "done" && before?.status !== "done") {
      this.count("slice-done", event, [slice]);
    }
    if (event.type === MissionEvents.sliceCreated || event.type === MissionEvents.sliceUpdated) {
      const by = (event.payload as { by?: string }).by ?? "unknown";
      if (before === undefined || before.spec !== slice.spec || before.title !== slice.title) {
        this.findIdeas(event, `${slice.title}\n${slice.spec}`, by, [slice]);
      }
    }
  }

  /**
   * A message delivered on this node (D627). It counts for the missions of the
   * thread it went to, else of the open slices its sender or recipient is
   * assigned; otherwise only for the node.
   */
  ingestMessage(event: StoredEvent): void {
    const payload = event.payload as { message?: AgentMessage; delivery?: MessageDelivery } | null;
    const message = payload?.message;
    if (message === undefined) return;
    let slices =
      payload?.delivery === undefined ? [] : this.slicesOfThread(payload.delivery.threadId);
    if (slices.length === 0) {
      slices = Object.values(this.missions.slices).filter(
        (slice) =>
          OPEN.has(slice.status) &&
          slice.assignee !== undefined &&
          (slice.assignee === message.from || slice.assignee === message.to),
      );
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
      pullRequest?: { key?: string; snapshot?: { state?: string } | null };
    } | null;
    const threadId = payload?.threadId;
    const key = payload?.pullRequest?.key;
    if (threadId === undefined || key === undefined) return;
    if (payload?.pullRequest?.snapshot?.state !== "merged") return;
    const merge = `${threadId}|${key}`;
    if (this.merges.has(merge)) return;
    this.merges.add(merge);
    this.count("merge", event, this.slicesOfThread(threadId));
  }

  /** Commits recorded on the `health` stream (D723). */
  ingestProgress(progress: Progress, event: StoredEvent): void {
    const slices = this.slicesOfThread(progress.threadId);
    for (let index = 0; index < progress.count; index += 1) {
      this.count(progress.kind, event, slices);
    }
  }

  /** Ceremony and progress of every group over the window, by kind. */
  status(config: HealthConfig, now: number) {
    this.prune(config, now);
    const byGroup = new Map<
      string,
      { ceremony: number; progress: number; byKind: Record<string, number>; refs: EventRef[] }
    >();
    for (const signal of this.signals) {
      for (const key of signal.groups) {
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

  private prune(config: HealthConfig, now: number): void {
    const since = now - config.windowHours * 3_600_000;
    if (this.signals.length > 0 && this.signals[0]!.time < since) {
      this.signals = this.signals.filter((signal) => signal.time >= since);
    }
  }

  /** What every detector finds now (D724, D726, D727). */
  evaluate(config: HealthConfig, health: HealthState, now: number): Finding[] {
    const findings: Finding[] = [];
    // Ceremony against progress, per group (D722). The narrowest group that
    // crosses warns; its project and the node stay quiet while it is open (D724).
    const rank = { mission: 0, team: 1, project: 2, node: 3 } as const;
    const quiet = new Set<string>();
    const hush = (group: HealthGroup) => {
      quiet.add("node");
      if (group.kind === "mission")
        quiet.add(groupKey({ kind: "project", projectId: group.projectId }));
    };
    for (const warning of Object.values(health.warnings)) {
      if (warning.detector === "ceremony" && warning.status === "open") hush(warning.group);
    }
    const entries = this.status(config, now).toSorted(
      (a, b) => rank[a.group.kind] - rank[b.group.kind],
    );
    for (const entry of entries) {
      const { ratio, minCeremony } = config.ceremony;
      const limit = Math.max(minCeremony, ratio * Math.max(entry.progress, 1));
      if (entry.ceremony < limit || quiet.has(entry.key)) continue;
      hush(entry.group);
      findings.push({
        detector: "ceremony",
        subject: entry.key,
        group: entry.group,
        summary: `${entry.ceremony} ceremony against ${entry.progress} progress in ${config.windowHours}h (warns at ${limit})`,
        measures: { ceremony: entry.ceremony, progress: entry.progress, threshold: limit },
        evidence: entry.refs.slice(-MAX_EVIDENCE),
      });
    }
    // Recursive proof loops: a done slice's proof recorded again and again (D726).
    for (const [sliceId, edits] of this.proofEdits) {
      if (edits.length < config.proofLoop.maxEdits) continue;
      const slice = this.missions.slices[sliceId];
      if (slice === undefined) continue;
      findings.push({
        detector: "proof-loop",
        subject: `slice:${sliceId}`,
        group: {
          kind: "mission",
          projectId: slice.projectId,
          missionId: slice.missionId,
          ...(this.missions.missions[slice.missionId]?.title === undefined
            ? {}
            : { title: this.missions.missions[slice.missionId]!.title }),
        },
        summary: `The proof of done slice "${slice.title}" was recorded again ${edits.length} times`,
        measures: { edits: edits.length, threshold: config.proofLoop.maxEdits },
        evidence: edits.slice(-MAX_EVIDENCE),
      });
    }
    // Mind virus: a corrected idea coming back (D727).
    for (const [ideaId, found] of this.occurrences) {
      const idea = health.ideas[ideaId];
      if (idea === undefined || found.length < config.mindVirus.minOccurrences) continue;
      const carriers = [...new Set(found.map((occurrence) => occurrence.carrier))];
      findings.push({
        detector: "mind-virus",
        subject: `idea:${ideaId}`,
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
