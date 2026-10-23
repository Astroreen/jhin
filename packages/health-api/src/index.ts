import { z } from "@jhin/sdk";

/**
 * Health: ceremony against progress (docs/plans/agents.md#a7-health-ceremony-against-progress-d721d740).
 * Sensors read the node's event log; what they conclude (warnings, their
 * analysis, corrected ideas, progress seen outside the log) is an event of one
 * `health` stream, and the state is its fold (`applyHealthEvent`), on the node
 * and in clients alike (D721).
 */
export const HEALTH_STREAM = "health";

/** Event types of the `health` stream (D721). */
export const HealthEvents = {
  /** `{ warning: Warning }`: a detector crossed its threshold (D724). */
  warningRaised: "health.warning.raised",
  /** `{ warningId, analysis: Analysis }`: what the agent with the context said (D725). */
  warningAnalysed: "health.warning.analysed",
  /** `{ warningId, dismissedAt, dismissedAfter?, by? }`: the owner has seen it (D724). */
  warningDismissed: "health.warning.dismissed",
  /** `{ warningId, clearedAt, reason, narrowerWarningId? }`: the sensors closed it, its measure back under the threshold or a narrower group warning for the same cause (D1383, D1384). */
  warningCleared: "health.warning.cleared",
  /** `{ idea: Idea }`: a wrong idea, named when it was corrected (D727). */
  ideaCorrected: "health.idea.corrected",
  /** `{ ideaId, by? }`: a corrected idea named by mistake, no longer watched for (D727). */
  ideaWithdrawn: "health.idea.withdrawn",
  /** `{ progress: Progress }`: commits a turn of a slice's thread made (D723). */
  progressRecorded: "health.progress.recorded",
} as const;
export type HealthEventType = (typeof HealthEvents)[keyof typeof HealthEvents];

/** Kernel event once an ended turn's commits are counted: `{ turnId, count }`, also 0 (D723). */
export const COMMITS_COUNTED_EVENT = "health.commits.counted";

/** Error codes of the `health.*` commands. */
export type HealthErrorCode = "WARNING_NOT_FOUND" | "IDEA_NOT_FOUND" | "PROJECT_NOT_FOUND";

/** The longest analyst's answer a warning keeps; a longer one is cut (D725). */
export const MAX_ANSWER_LENGTH = 8_000;

/** Reading health: sensors, warnings, ideas and the `health` stream. */
export const HEALTH_READ_PERMISSION = "health.read";
/** Dismissing warnings and naming corrected ideas. */
export const HEALTH_WRITE_PERMISSION = "health.write";

/**
 * What a sensor counts over (D722). A team is A5's: until teams land, a
 * warning is per mission, per project or for the whole node.
 */
export const HealthGroup = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node") }),
  z.object({ kind: z.literal("project"), projectId: z.string() }),
  z.object({
    kind: z.literal("mission"),
    projectId: z.string(),
    missionId: z.string(),
    /** The mission's title when the group was counted. */
    title: z.string().optional(),
  }),
  z.object({ kind: z.literal("team"), teamId: z.string() }),
]);
export type HealthGroup = z.infer<typeof HealthGroup>;

/** A stable key of a group: `node`, `project:<id>`, `mission:<id>`, `team:<id>`. */
export function groupKey(group: HealthGroup): string {
  switch (group.kind) {
    case "node":
      return "node";
    case "project":
      return `project:${group.projectId}`;
    case "mission":
      return `mission:${group.missionId}`;
    case "team":
      return `team:${group.teamId}`;
  }
}

/** Ceremony: the work around the work (D600, D722). */
export const CEREMONY_KINDS = [
  "message",
  "ask",
  "answer",
  "approval",
  "proof-edit",
  "queue",
  "review",
] as const;
/** Progress: the work moving (D722). */
export const PROGRESS_KINDS = ["slice-done", "commit", "merge"] as const;
export const SignalKind = z.enum([...CEREMONY_KINDS, ...PROGRESS_KINDS]);
export type SignalKind = z.infer<typeof SignalKind>;
export const isCeremony = (kind: SignalKind): boolean =>
  (CEREMONY_KINDS as readonly string[]).includes(kind);

/** An event of the log a warning stands on: the drill-down reads it back (D728). */
export const EventRef = z.object({
  stream: z.string(),
  sequence: z.number().int().positive(),
  type: z.string(),
  at: z.string(),
  kind: SignalKind.optional(),
});
export type EventRef = z.infer<typeof EventRef>;

export const DETECTORS = ["ceremony", "proof-loop", "mind-virus"] as const;
export const Detector = z.enum(DETECTORS);
export type Detector = z.infer<typeof Detector>;

/** What the agent with the context said about a warning (D725). */
export const Analysis = z.object({
  /** `answered`; `failed` when the ask failed; `none` when no agent has the context. */
  status: z.enum(["answered", "failed", "none"]),
  /** The address asked; absent with `none`. */
  analyst: z.string().optional(),
  /** Why this agent: `config`, `team-lead` or `assignee` (D726). */
  reason: z.string().optional(),
  answer: z.string().optional(),
  error: z.string().optional(),
  at: z.string(),
});
export type Analysis = z.infer<typeof Analysis>;

export const Warning = z.object({
  warningId: z.string(),
  detector: Detector,
  /** What it is about, unique per detector while it is open: a group key, a slice or an idea. */
  subject: z.string(),
  group: HealthGroup,
  /** One line on what crossed which threshold. */
  summary: z.string(),
  /** The numbers behind it, e.g. `{ ceremony, progress, threshold }`. */
  measures: z.record(z.string(), z.number()),
  /** The events behind it, newest last, at most `MAX_EVIDENCE`. */
  evidence: z.array(EventRef),
  raisedAt: z.string(),
  status: z.enum(["open", "dismissed", "cleared"]),
  dismissedAt: z.string().optional(),
  /** When the sensors cleared it, and why: a short machine-readable reason, `under-threshold` (D1383). */
  clearedAt: z.string().optional(),
  clearedReason: z.string().optional(),
  /** The narrower group's warning that closed this one, when the reason is `narrower` (D1384). */
  narrowerWarningId: z.string().optional(),
  /**
   * The last event of each followed stream when it was dismissed, by stream:
   * the subject counts again only from the events after them (D724).
   */
  dismissedAfter: z.record(z.string(), z.number()).optional(),
  analysis: Analysis.optional(),
});
export type Warning = z.infer<typeof Warning>;

/** How many events a warning keeps as its evidence. */
export const MAX_EVIDENCE = 50;

/** A wrong idea, named when it was corrected: the vaccine a mind virus is detected by (D727). */
export const Idea = z.object({
  ideaId: z.string(),
  /** The phrase that carries it; matched case-insensitively, whitespace collapsed. */
  idea: z.string(),
  /** What is right instead, told to the analyst. */
  correction: z.string().optional(),
  projectId: z.string().optional(),
  by: z.string().optional(),
  correctedAt: z.string(),
});
export type Idea = z.infer<typeof Idea>;

/**
 * Progress no stream holds (D723): the commits of a turn. Merged pull requests
 * are read from the `source-control` stream, which holds them.
 */
export const Progress = z.object({
  kind: z.enum(["commit"]),
  /** Commits in the turn. */
  count: z.number().int().positive(),
  threadId: z.string(),
  projectId: z.string(),
  /** The head after the turn. */
  ref: z.string(),
  at: z.string(),
});
export type Progress = z.infer<typeof Progress>;

/** The `jhin.health` section: every threshold is config (D729). */
export const HEALTH_CONFIG_SECTION = "jhin.health";
export const HealthConfig = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .meta({ title: "Enabled", description: "Run the sensors and raise warnings." }),
    windowHours: z.number().positive().default(24).meta({
      title: "Window (hours)",
      description: "How far back ceremony and progress are counted.",
    }),
    ceremony: z
      .object({
        ratio: z.number().positive().default(10).meta({
          title: "Ratio",
          description:
            "Warn when ceremony reaches this many times progress (progress 0 counts as 1).",
        }),
        minCeremony: z.number().int().positive().default(30).meta({
          title: "Minimum ceremony",
          description: "No warning below this much ceremony in the window.",
        }),
      })
      .default({ ratio: 10, minCeremony: 30 })
      .meta({ title: "Ceremony against progress" }),
    proofLoop: z
      .object({
        maxEdits: z.number().int().positive().default(2).meta({
          title: "Proof edits",
          description: "Warn when a done slice's proof has been recorded again this many times.",
        }),
      })
      .default({ maxEdits: 2 })
      .meta({ title: "Recursive proof loop" }),
    mindVirus: z
      .object({
        minOccurrences: z.number().int().positive().default(2).meta({
          title: "Occurrences",
          description: "Warn when a corrected idea comes back this many times.",
        }),
      })
      .default({ minOccurrences: 2 })
      .meta({ title: "Mind virus" }),
    // A day at most: setTimeout takes no more than 2^31 - 1 ms (about 24.8 days).
    analysisTimeoutMinutes: z.number().positive().max(1440).default(30).meta({
      title: "Analysis timeout (minutes)",
      description: "How long the analyst may take to answer before the analysis counts as failed.",
    }),
    analysts: z.record(z.string(), z.string()).default({}).meta({
      title: "Analysts",
      description:
        "Who analyses a warning, by project id (`*` for any): an agent address. Without one, the team's lead, else the agent assigned most of the mission's slices.",
    }),
  })
  .meta({
    title: "Health",
    description: "Ceremony against progress: sensors, thresholds and who analyses a warning.",
  });
export type HealthConfig = z.output<typeof HealthConfig>;

/**
 * Everything of one node's `health` stream, folded. Commits recorded on it
 * (`health.progress.recorded`) are counted by the sensors over the window,
 * not kept here, so the fold does not grow with every turn.
 */
export interface HealthState {
  /** By warning id. */
  readonly warnings: Readonly<Record<string, Warning>>;
  /** By idea id. */
  readonly ideas: Readonly<Record<string, Idea>>;
}

export const EMPTY_HEALTH: HealthState = { warnings: {}, ideas: {} };

/** Applies one event of the `health` stream; unknown types are skipped. */
export function applyHealthEvent(
  state: HealthState,
  event: { readonly type: string; readonly payload: unknown },
): HealthState {
  const payload = (event.payload ?? {}) as {
    warning?: Warning;
    warningId?: string;
    analysis?: Analysis;
    dismissedAt?: string;
    dismissedAfter?: Record<string, number>;
    clearedAt?: string;
    reason?: string;
    narrowerWarningId?: string;
    idea?: Idea;
  };
  switch (event.type) {
    case HealthEvents.warningRaised:
      if (payload.warning === undefined) return state;
      return {
        ...state,
        warnings: { ...state.warnings, [payload.warning.warningId]: payload.warning },
      };
    case HealthEvents.warningCleared: {
      const warning =
        payload.warningId === undefined ? undefined : state.warnings[payload.warningId];
      if (warning === undefined) return state;
      return {
        ...state,
        warnings: {
          ...state.warnings,
          [warning.warningId]: {
            ...warning,
            status: "cleared",
            ...(payload.clearedAt === undefined ? {} : { clearedAt: payload.clearedAt }),
            ...(payload.reason === undefined ? {} : { clearedReason: payload.reason }),
            ...(payload.narrowerWarningId === undefined
              ? {}
              : { narrowerWarningId: payload.narrowerWarningId }),
          },
        },
      };
    }
    case HealthEvents.warningAnalysed:
    case HealthEvents.warningDismissed: {
      const warning =
        payload.warningId === undefined ? undefined : state.warnings[payload.warningId];
      if (warning === undefined) return state;
      const next: Warning =
        event.type === HealthEvents.warningAnalysed
          ? payload.analysis === undefined
            ? warning
            : { ...warning, analysis: payload.analysis }
          : {
              ...warning,
              status: "dismissed",
              ...(payload.dismissedAt === undefined ? {} : { dismissedAt: payload.dismissedAt }),
              ...(payload.dismissedAfter === undefined
                ? {}
                : { dismissedAfter: payload.dismissedAfter }),
            };
      return { ...state, warnings: { ...state.warnings, [warning.warningId]: next } };
    }
    case HealthEvents.ideaCorrected:
      if (payload.idea === undefined) return state;
      return { ...state, ideas: { ...state.ideas, [payload.idea.ideaId]: payload.idea } };
    case HealthEvents.ideaWithdrawn: {
      const ideaId = (event.payload as { ideaId?: string } | null)?.ideaId;
      if (ideaId === undefined || state.ideas[ideaId] === undefined) return state;
      const { [ideaId]: _withdrawn, ...ideas } = state.ideas;
      return { ...state, ideas };
    }
    default:
      return state;
  }
}

/** Warnings newest first. */
export const warningsOf = (state: HealthState): Warning[] =>
  Object.values(state.warnings).toSorted((a, b) => b.raisedAt.localeCompare(a.raisedAt));

/**
 * How a phrase is matched by the mind-virus detector (D727): lower case,
 * punctuation and whitespace collapsed to single spaces, so whole words match.
 */
export const normalizeIdea = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A corrected idea is a phrase of two words at least: one word matches too much (D727). */
export const MIN_IDEA_WORDS = 2;

/** Whether `text` carries `idea`, both normalized: as whole words, not inside other words. */
export const carriesIdea = (text: string, idea: string): boolean =>
  ` ${text} `.includes(` ${idea} `);

/** The status of the sensors of one group over the window (`health.status`). */
export const GroupStatus = z.object({
  group: HealthGroup,
  ceremony: z.number().int(),
  progress: z.number().int(),
  /** Counts by signal kind. */
  byKind: z.record(z.string(), z.number()),
});
export type GroupStatus = z.infer<typeof GroupStatus>;
