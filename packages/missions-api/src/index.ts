import { z } from "@jhin/sdk";

/**
 * Missions and slices of a node's projects (docs/plans/agents.md#a3-missions-and-slices-d641d660):
 * every change is an event of one `missions` stream, and the state is the fold
 * of that stream (`applyMissionEvent`), on the node and in clients alike (D641).
 */
export const MISSIONS_STREAM = "missions";

/** Event types of the `missions` stream (D642). Each carries the whole record after the change. */
export const MissionEvents = {
  /** `{ intent, by?, traceId? }`: a project's intent or process changed. */
  intentSet: "missions.intent.set",
  /** `{ mission, by?, traceId? }` */
  missionCreated: "missions.mission.created",
  /** `{ mission, by?, traceId? }`: outcome, title, status or process changed. */
  missionUpdated: "missions.mission.updated",
  /** `{ slice, by?, traceId? }` */
  sliceCreated: "missions.slice.created",
  /** `{ slice, by?, traceId? }`: spec, order, assignee, status, step or threads changed. */
  sliceUpdated: "missions.slice.updated",
  /** `{ slice, by?, traceId? }`: the slice's proof was recorded (again, if it already had one). */
  sliceProved: "missions.slice.proved",
  /** `{ slice, by?, traceId? }`: a review of the slice's work was recorded (L2, D1242). */
  sliceReviewed: "missions.slice.reviewed",
  /** `{ mission, by?, traceId? }`: the mission, as it was, is deleted with its slices (D1395). */
  missionDeleted: "missions.mission.deleted",
  /** `{ slice, by?, traceId? }`: the slice, as it was, is deleted (D1395). */
  sliceDeleted: "missions.slice.deleted",
} as const;
export type MissionEventType = (typeof MissionEvents)[keyof typeof MissionEvents];

/** The payload key holding each event's record. */
export const MISSION_EVENT_RECORD = {
  [MissionEvents.intentSet]: "intent",
  [MissionEvents.missionCreated]: "mission",
  [MissionEvents.missionUpdated]: "mission",
  [MissionEvents.sliceCreated]: "slice",
  [MissionEvents.sliceUpdated]: "slice",
  [MissionEvents.sliceProved]: "slice",
  [MissionEvents.sliceReviewed]: "slice",
  [MissionEvents.missionDeleted]: "mission",
  [MissionEvents.sliceDeleted]: "slice",
} as const satisfies Record<MissionEventType, "intent" | "mission" | "slice">;

/** Error codes of the `missions.*` and `slices.*` commands. */
export type MissionErrorCode =
  | "PROJECT_NOT_FOUND"
  | "MISSION_NOT_FOUND"
  | "SLICE_NOT_FOUND"
  /** A dependency is in another mission, not in an earlier wave, or a newly named dropped slice. */
  | "SLICE_ORDER_INVALID"
  /** `step` is not a step of the mission's slice process. */
  | "SLICE_STEP_INVALID"
  /** `step` is not a step of the mission's own process (between its slices). */
  | "MISSION_STEP_INVALID"
  /** A slice is marked done without a proof: record one with `slices.prove`. */
  | "PROOF_REQUIRED"
  /** Another slice that is not deleted depends on the slice or reviews it (D1395). */
  | "SLICE_IN_USE"
  /** A dropped slice stays dropped (D651): plan a new one instead. */
  | "SLICE_DROPPED"
  /** A done or dropped mission takes no new slices: reopen it or plan another. */
  | "MISSION_CLOSED"
  /** Other writers kept appending to the stream; try again. */
  | "MISSIONS_BUSY";

/**
 * Who works on a slice (D645): an agent, `jhin://<nodeId>/agents/<id>`, or
 * the owner of a node, `jhin://<nodeId>/owner`. Only the address is kept, so
 * the agent need not exist yet and may live on another node.
 */
export const Assignee = z
  .string()
  .regex(
    /^jhin:\/\/[^/\s]+\/(agents\/[^/\s]+|owner)$/,
    "must be jhin://<nodeId>/agents/<id> or jhin://<nodeId>/owner",
  );

/** One step of a process: `spec`, `build`, `test`, `merge`, `release`. */
export const Step = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/, "lowercase letters, digits and -")
    .describe("The step's id, e.g. build"),
  description: z.string().max(2000).optional().describe("What the step means here"),
  review: z
    .boolean()
    .optional()
    .describe(
      "Taken only once the work is reviewed after its last change, e.g. commit or merge (D1241)",
    ),
});
export type Step = z.infer<typeof Step>;

/** Ordered steps; ids are unique. */
export const Steps = z
  .array(Step)
  .max(20)
  .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, {
    message: "step ids must be unique",
  });

/**
 * The process of a mission as data (D648): the steps every slice goes
 * through, and those of the mission between its slices. Nothing here runs it;
 * an orchestrator (A6) reads it.
 */
export const MissionProcess = z.object({
  slice: Steps.describe("Every slice, in order, e.g. spec → build → test"),
  mission: Steps.describe("Between the mission's slices, e.g. merge"),
});
export type MissionProcess = z.infer<typeof MissionProcess>;

export const DEFAULT_MISSION_PROCESS: MissionProcess = {
  slice: [{ id: "spec" }, { id: "build" }, { id: "test" }],
  mission: [{ id: "merge", review: true }],
};

/**
 * Before a mission takes a step of its own process (`missions.update { step }`),
 * this hook runs with `{ mission, step }`: a plugin refuses the step by
 * throwing. The orchestrator refuses a step that needs a review while a slice
 * changed after its last one (D1241).
 */
export const MISSION_STEP_HOOK = "missions.step";

/**
 * Before a mission, or one of its slices, is deleted (`missions.delete`,
 * `slices.delete`, D1395), this hook runs with `{ mission, sliceId? }`: a
 * plugin refuses by throwing. The orchestrator refuses while a run of the
 * mission is active.
 */
export const MISSION_DELETE_HOOK = "missions.deleting";

/** A project's intent (D643): what the project is for, and its process between missions. */
export const ProjectIntent = z.object({
  projectId: z.string(),
  /** One paragraph. */
  intent: z.string(),
  /** Between missions, e.g. plan → release. */
  process: Steps,
  updatedAt: z.string(),
});
export type ProjectIntent = z.infer<typeof ProjectIntent>;

export const MISSION_STATUSES = ["planned", "active", "done", "dropped"] as const;
export const MissionStatus = z.enum(MISSION_STATUSES);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const Mission = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  /** What the mission achieves when it is done. */
  outcome: z.string(),
  status: MissionStatus,
  process: MissionProcess,
  /** The step of its own process the mission took last (D1241). */
  step: z.string().optional(),
  /**
   * Set by the reading commands, never stored: the mission's project is gone
   * from the node (D1399). Absent where the node cannot tell.
   */
  projectDeleted: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Mission = z.infer<typeof Mission>;

export const SLICE_STATUSES = ["planned", "active", "blocked", "done", "dropped"] as const;
export const SliceStatus = z.enum(SLICE_STATUSES);
export type SliceStatus = z.infer<typeof SliceStatus>;

/** A thread working on a slice; `nodeId` when it lives on another node of the mesh. */
export const SliceThread = z.object({
  threadId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
});
export type SliceThread = z.infer<typeof SliceThread>;

/** A proof points only at http(s): a rendered link never runs a script. */
const ProofUrl = z
  .string()
  .max(2000)
  .regex(/^https?:\/\/\S/i, "an http(s) URL");

/** One piece of proof (D646): a command with its output, a screenshot, or a link. */
export const ProofItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    command: z.string().min(1).max(2000),
    output: z.string().max(20_000),
  }),
  z.object({
    kind: z.literal("screenshot"),
    url: ProofUrl,
    caption: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal("link"),
    url: ProofUrl,
    title: z.string().max(500).optional(),
  }),
]);
export type ProofItem = z.infer<typeof ProofItem>;

/** Small on purpose: the work proven once, not every check that could be run ("bureaucracy"). */
export const ProofItems = z.array(ProofItem).min(1).max(10);

export const Proof = z.object({
  items: ProofItems,
  recordedAt: z.string(),
  /** Who recorded it: the caller's id. */
  by: z.string().optional(),
});
export type Proof = z.infer<typeof Proof>;

/**
 * The files a review saw (D1242): where the slice's work lives (a thread's
 * worktree, else its project) and the git tree of its content then, from
 * `git.tree`. The same tree there later means nothing changed since.
 */
export const ReviewedWork = z.object({
  projectId: z.string(),
  threadId: z.string().optional(),
  path: z.string(),
  tree: z.string(),
});
export type ReviewedWork = z.infer<typeof ReviewedWork>;

/**
 * Folders a review's `git.tree` leaves out (D1261): the agents' inherited
 * knowledge (`.jhin/agents/<id>/`, D607), which agents write as they work,
 * is not the work under review.
 */
export const REVIEW_TREE_EXCLUDE: readonly string[] = [".jhin/agents"];

export const REVIEW_VERDICTS = ["approved", "changes-requested"] as const;
export const ReviewVerdict = z.enum(REVIEW_VERDICTS);

/** The last review of a slice's work (D1242). */
export const SliceReview = z.object({
  verdict: ReviewVerdict,
  /** What the reviewer checked, and what it found. */
  notes: z.string().max(20_000).optional(),
  /** The files reviewed; absent on a node without `git.tree`. */
  work: ReviewedWork.optional(),
  recordedAt: z.string(),
  /** Who recorded it: the caller's id. */
  by: z.string().optional(),
});
export type SliceReview = z.infer<typeof SliceReview>;

export const Slice = z.object({
  id: z.string(),
  missionId: z.string(),
  projectId: z.string(),
  title: z.string(),
  /** What must work when the slice is done. */
  spec: z.string(),
  /** Slices of a wave run in parallel; waves run one after another (1 first). */
  wave: z.number().int().min(1),
  /** Slices of the same mission, in earlier waves, that must be done first. */
  dependsOn: z.array(z.string()),
  assignee: Assignee.optional(),
  status: SliceStatus,
  /** Where the slice is in its mission's slice process. */
  step: z.string().optional(),
  threads: z.array(SliceThread),
  proof: Proof.optional(),
  /** Slices of the same mission, in earlier waves, whose work this slice reviews (D1243). */
  reviews: z.array(z.string()).optional(),
  /** The last review of this slice's work (D1242). */
  review: SliceReview.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Slice = z.infer<typeof Slice>;

/** Everything of one node's `missions` stream, folded. */
export interface MissionsState {
  /** By project id. */
  readonly intents: Readonly<Record<string, ProjectIntent>>;
  /** By mission id. */
  readonly missions: Readonly<Record<string, Mission>>;
  /** By slice id. */
  readonly slices: Readonly<Record<string, Slice>>;
}

export const EMPTY_MISSIONS: MissionsState = { intents: {}, missions: {}, slices: {} };

/** Applies one event of the `missions` stream; unknown types are skipped. */
export function applyMissionEvent(
  state: MissionsState,
  event: { readonly type: string; readonly payload: unknown },
): MissionsState {
  const payload = (event.payload ?? {}) as {
    intent?: ProjectIntent;
    mission?: Mission;
    slice?: Slice;
  };
  // A deletion is a tombstone (D1395): the record leaves the fold, and a mission's slices with it.
  if (event.type === MissionEvents.missionDeleted && payload.mission !== undefined) {
    const id = payload.mission.id;
    const { [id]: _mission, ...missions } = state.missions;
    const slices = Object.fromEntries(
      Object.entries(state.slices).filter(([, slice]) => slice.missionId !== id),
    );
    return { ...state, missions, slices };
  }
  if (event.type === MissionEvents.sliceDeleted && payload.slice !== undefined) {
    const id = payload.slice.id;
    if (state.slices[id] === undefined) return state;
    const { [id]: _slice, ...slices } = state.slices;
    return { ...state, slices };
  }
  switch (MISSION_EVENT_RECORD[event.type as MissionEventType]) {
    case "intent":
      if (payload.intent === undefined) return state;
      return {
        ...state,
        intents: { ...state.intents, [payload.intent.projectId]: payload.intent },
      };
    case "mission":
      if (payload.mission === undefined) return state;
      return { ...state, missions: { ...state.missions, [payload.mission.id]: payload.mission } };
    case "slice":
      if (payload.slice === undefined) return state;
      return { ...state, slices: { ...state.slices, [payload.slice.id]: payload.slice } };
    default:
      return state;
  }
}

/** A project's missions, oldest first. */
export const missionsOf = (state: MissionsState, projectId: string): Mission[] =>
  Object.values(state.missions)
    .filter((mission) => mission.projectId === projectId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

/** A mission's slices by wave, then oldest first. */
export const slicesOf = (state: MissionsState, missionId: string): Slice[] =>
  Object.values(state.slices)
    .filter((slice) => slice.missionId === missionId)
    .toSorted((a, b) => a.wave - b.wave || a.createdAt.localeCompare(b.createdAt));

/** A mission's slices grouped by wave, waves in order. */
export function wavesOf(slices: readonly Slice[]): { wave: number; slices: Slice[] }[] {
  const waves = new Map<number, Slice[]>();
  for (const slice of slices) waves.set(slice.wave, [...(waves.get(slice.wave) ?? []), slice]);
  return [...waves]
    .toSorted(([a], [b]) => a - b)
    .map(([wave, members]) => ({ wave, slices: members }));
}

/** What a slice serves, from the slice up (D650): what A6's refocus hands an agent. */
export const IntentChain = z.object({
  slice: z.object({ id: z.string(), title: z.string(), spec: z.string(), status: SliceStatus }),
  mission: z.object({ id: z.string(), title: z.string(), outcome: z.string() }),
  project: z.object({ id: z.string(), intent: z.string().optional() }),
});
export type IntentChain = z.infer<typeof IntentChain>;

export function intentChain(state: MissionsState, sliceId: string): IntentChain | undefined {
  const slice = state.slices[sliceId];
  const mission = slice === undefined ? undefined : state.missions[slice.missionId];
  if (slice === undefined || mission === undefined) return undefined;
  const intent = state.intents[mission.projectId]?.intent;
  return {
    slice: { id: slice.id, title: slice.title, spec: slice.spec, status: slice.status },
    mission: { id: mission.id, title: mission.title, outcome: mission.outcome },
    project: { id: mission.projectId, ...(intent === undefined ? {} : { intent }) },
  };
}

// --- Progress (agents.md D702) -------------------------------------------------

/**
 * Why a slice waits for whoever runs the mission (D702): it has no assignee,
 * its assignee set it blocked, a slice it depends on was dropped (it must be
 * re-planned, D651), its assignee is an agent of another node (only for a
 * caller that asks so), or its assignee's node is away (D1547).
 */
export const DECISION_REASONS = ["unassigned", "blocked", "orphaned", "elsewhere", "away"] as const;
export const Decision = z.object({
  sliceId: z.string(),
  reason: z.enum(DECISION_REASONS),
  /** For `orphaned`: the dropped slices it depends on. */
  dropped: z.array(z.string()).optional(),
});
export type Decision = z.infer<typeof Decision>;

export const MissionProgress = z.object({
  /** The earliest wave with open slices; null once every slice is done or dropped. */
  wave: z.number().int().nullable(),
  /** Planned slices of that wave that can be handed to their assignee now. */
  ready: z.array(z.string()),
  /** Active slices of that wave: handed, not proved yet. */
  working: z.array(z.string()),
  decisions: z.array(Decision),
  /** How many slices the mission has, dropped ones included. */
  total: z.number().int(),
  /** No slice is open: every one is done or dropped. */
  slicesDone: z.boolean(),
});
export type MissionProgress = z.infer<typeof MissionProgress>;

const isOpenSlice = (slice: Slice) => slice.status !== "done" && slice.status !== "dropped";

/**
 * Where a mission's slices are (D702). Waves run one after another: only the
 * earliest wave with open slices moves, and its planned slices are ready once
 * they have an assignee and none of their dependencies is dropped. A slice
 * whose dependency was dropped is reported in any wave, since it can never
 * start as planned. `nodeId`, when given, reports an agent of another node
 * as `elsewhere` instead of ready. `away`, the nodes away (D1547), reports a
 * planned or active slice whose assignee lives on one as `away`.
 */
export function missionProgress(
  slices: readonly Slice[],
  options: { readonly nodeId?: string; readonly away?: ReadonlySet<string> } = {},
): MissionProgress {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const open = slices.filter(isOpenSlice);
  const wave = open.length === 0 ? null : Math.min(...open.map((slice) => slice.wave));
  const ready: string[] = [];
  const working: string[] = [];
  const decisions: Decision[] = [];
  for (const slice of slicesInOrder(open)) {
    const dropped = slice.dependsOn.filter((id) => byId.get(id)?.status === "dropped");
    if (dropped.length > 0) {
      decisions.push({ sliceId: slice.id, reason: "orphaned", dropped });
      continue;
    }
    if (slice.wave !== wave) continue;
    const node = slice.assignee === undefined ? undefined : nodeOfAddress(slice.assignee);
    if (
      node !== undefined &&
      options.away?.has(node) === true &&
      (slice.status === "active" || slice.status === "planned")
    ) {
      decisions.push({ sliceId: slice.id, reason: "away" });
      continue;
    }
    if (slice.status === "active") working.push(slice.id);
    else if (slice.status === "blocked") decisions.push({ sliceId: slice.id, reason: "blocked" });
    else if (slice.assignee === undefined)
      decisions.push({ sliceId: slice.id, reason: "unassigned" });
    else if (
      options.nodeId !== undefined &&
      !slice.assignee.startsWith(`jhin://${options.nodeId}/`)
    )
      decisions.push({ sliceId: slice.id, reason: "elsewhere" });
    else ready.push(slice.id);
  }
  return { wave, ready, working, decisions, total: slices.length, slicesDone: open.length === 0 };
}

/** The node of a `jhin://<nodeId>/…` address. */
export const nodeOfAddress = (address: string): string | undefined =>
  /^jhin:\/\/([^/?#]+)\//.exec(address)?.[1];

const slicesInOrder = (slices: readonly Slice[]) =>
  slices.toSorted((a, b) => a.wave - b.wave || a.createdAt.localeCompare(b.createdAt));

// --- Review after the last change (agents.md D1241) ------------------------------

/**
 * Why a slice keeps a step that needs a review from being taken: it was never
 * reviewed, its last review asked for changes, it changed after its last
 * review, or the files its review saw cannot be read now.
 */
export const UNREVIEWED_REASONS = [
  "unreviewed",
  "changes-requested",
  "changed-after-review",
  "work-unknown",
] as const;
export const Unreviewed = z.object({
  sliceId: z.string(),
  reason: z.enum(UNREVIEWED_REASONS),
  /** Where the work lives, when the review recorded it. */
  path: z.string().optional(),
});
export type Unreviewed = z.infer<typeof Unreviewed>;

export const ReviewCheck = z.object({
  /** No slice keeps a step that needs a review from being taken. */
  clear: z.boolean(),
  unreviewed: z.array(Unreviewed),
});
export type ReviewCheck = z.infer<typeof ReviewCheck>;

/** The places a mission's reviews saw, so their trees can be read again. */
export function reviewedWork(slices: readonly Slice[]): ReviewedWork[] {
  const byPath = new Map<string, ReviewedWork>();
  for (const slice of slices) {
    const work = slice.review?.work;
    if (work !== undefined && !byPath.has(work.path)) byPath.set(work.path, work);
  }
  return [...byPath.values()];
}

/**
 * Which done slices of a mission were not reviewed after their last change
 * (D1241). A review slice (one with `reviews`, D1243) needs no review itself.
 * A slice is reviewed when its last review approved it after its proof and the
 * files where it lives are still those the latest review there saw: `trees`
 * holds each reviewed path's tree now (`git.tree`), so a change by anyone after
 * the review, the lead's included, shows. A review recorded without its files
 * (no `git.tree` on the node) is checked by its time alone.
 */
export function reviewCheck(
  slices: readonly Slice[],
  trees: ReadonlyMap<string, string>,
): ReviewCheck {
  const latest = new Map<string, SliceReview & { work: ReviewedWork }>();
  for (const slice of slices) {
    const review = slice.review;
    if (review?.work === undefined) continue;
    const seen = latest.get(review.work.path);
    if (seen === undefined || seen.recordedAt < review.recordedAt)
      latest.set(review.work.path, { ...review, work: review.work });
  }
  const unreviewed: Unreviewed[] = [];
  for (const slice of slicesInOrder(slices)) {
    if (slice.status !== "done" || (slice.reviews?.length ?? 0) > 0) continue;
    const review = slice.review;
    const path = review?.work?.path;
    const at = path === undefined ? {} : { path };
    const last = path === undefined ? review : latest.get(path);
    if (review === undefined) unreviewed.push({ sliceId: slice.id, reason: "unreviewed" });
    else if (review.verdict !== "approved" || last?.verdict !== "approved")
      unreviewed.push({ sliceId: slice.id, reason: "changes-requested", ...at });
    else if (slice.proof !== undefined && review.recordedAt < slice.proof.recordedAt)
      unreviewed.push({ sliceId: slice.id, reason: "changed-after-review", ...at });
    else if (path !== undefined) {
      const now = trees.get(path);
      if (now === undefined) unreviewed.push({ sliceId: slice.id, reason: "work-unknown", path });
      else if (now !== last?.work?.tree)
        unreviewed.push({ sliceId: slice.id, reason: "changed-after-review", path });
    }
  }
  return { clear: unreviewed.length === 0, unreviewed };
}

// --- Markdown (D649) ------------------------------------------------------------

const steps = (list: readonly Step[]) =>
  list.length === 0 ? "none" : list.map((step) => step.id).join(" → ");

/** A block of text that may itself contain fences. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/**
 * The renderer's lines as one document: blank lines it put twice are one, while
 * a block it holds (fenced output, the user's text) keeps its own blank lines.
 */
const document = (lines: readonly string[]) =>
  `${lines
    .filter((line, index) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trimEnd()}\n`;

/** Text kept on one line: a title, caption or fact. */
const inline = (text: string) => text.replace(/\s+/g, " ").trim();

/** User text read literally on one line: Markdown's inline characters escaped. */
const literal = (text: string) => inline(text).replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`);

/** A URL that cannot end its link early: parentheses, spaces and angle brackets encoded. */
const href = (url: string) =>
  url.replace(
    /[()<>\s]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );

/**
 * Free text of the user (an intent, outcome or spec) as Markdown inside the
 * document: it keeps its lists, emphasis and code, but its headings are
 * escaped so they never become sections of the document, and a fence it opens
 * is closed where the text ends.
 */
function prose(text: string): string {
  let open: string | undefined;
  const lines = text
    .replace(/\s+$/, "")
    .split("\n")
    .map((line, index, all) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (open !== undefined) {
        if (fence !== undefined && fence[0] === open[0] && fence.length >= open.length) {
          if (line.trim() === fence) open = undefined;
        }
        return line;
      }
      if (fence !== undefined) {
        open = fence;
        return line;
      }
      // An ATX heading, or a setext underline that would turn the line above into one;
      // a rule or bare list item after a blank line stays as written.
      const underline = /^ {0,3}(=+|-+)\s*$/.test(line) && (all[index - 1] ?? "").trim() !== "";
      return /^ {0,3}#/.test(line) || underline ? line.replace(/^( {0,3})/, "$1\\") : line;
    });
  return [...lines, ...(open === undefined ? [] : [open])].join("\n");
}

function renderProof(proof: Proof): string[] {
  const lines = [
    `**Proof** (${literal(proof.recordedAt)}${proof.by === undefined ? "" : `, ${literal(proof.by)}`}):`,
    "",
  ];
  for (const item of proof.items) {
    if (item.kind === "command") {
      lines.push(fenced(`$ ${item.command}\n${item.output}`), "");
    } else if (item.kind === "screenshot") {
      lines.push(`- ![${literal(item.caption ?? "screenshot")}](${href(item.url)})`, "");
    } else {
      lines.push(`- [${literal(item.title ?? item.url)}](${href(item.url)})`, "");
    }
  }
  return lines;
}

function renderSlice(slice: Slice, titles: ReadonlyMap<string, string>): string[] {
  const facts = [
    `- Status: ${slice.status}${slice.step === undefined ? "" : ` (step: ${slice.step})`}`,
    `- Assignee: ${slice.assignee === undefined ? "unassigned" : literal(slice.assignee)}`,
  ];
  if (slice.dependsOn.length > 0) {
    facts.push(
      `- Depends on: ${slice.dependsOn.map((id) => literal(titles.get(id) ?? id)).join(", ")}`,
    );
  }
  if (slice.reviews !== undefined && slice.reviews.length > 0) {
    facts.push(`- Reviews: ${slice.reviews.map((id) => literal(titles.get(id) ?? id)).join(", ")}`);
  }
  if (slice.review !== undefined) {
    facts.push(
      `- Review: ${slice.review.verdict} (${literal(slice.review.recordedAt)}${slice.review.by === undefined ? "" : `, ${literal(slice.review.by)}`})`,
    );
  }
  if (slice.threads.length > 0) {
    facts.push(
      `- Threads: ${slice.threads
        .map((thread) =>
          literal(
            thread.nodeId === undefined ? thread.threadId : `${thread.nodeId}/${thread.threadId}`,
          ),
        )
        .join(", ")}`,
    );
  }
  return [
    `#### ${literal(slice.title)}`,
    "",
    `Slice \`${slice.id}\``,
    "",
    ...facts,
    "",
    "**Spec**",
    "",
    prose(slice.spec),
    "",
    ...(slice.proof === undefined ? [] : renderProof(slice.proof)),
  ];
}

/** One mission as Markdown: outcome, process, then its slices wave by wave. */
export function renderMission(mission: Mission, slices: readonly Slice[]): string {
  const titles = new Map(slices.map((slice) => [slice.id, slice.title]));
  const lines = [
    `## Mission: ${literal(mission.title)}`,
    "",
    `Mission \`${mission.id}\` · ${mission.status}`,
    "",
    "**Outcome**",
    "",
    prose(mission.outcome),
    "",
    `**Process**: slice ${steps(mission.process.slice)}; mission ${steps(mission.process.mission)}${mission.step === undefined ? "" : ` (step: ${mission.step})`}`,
    "",
  ];
  for (const { wave, slices: members } of wavesOf(slices)) {
    lines.push(`### Wave ${wave}`, "");
    for (const slice of members) lines.push(...renderSlice(slice, titles));
  }
  return document(lines);
}

/** A project's intent and missions as Markdown; `missionId` renders only that mission. */
export function renderMarkdown(
  state: MissionsState,
  projectId: string,
  options: { readonly missionId?: string; readonly projectName?: string | undefined } = {},
): string {
  const intent = state.intents[projectId];
  const missions = missionsOf(state, projectId).filter(
    (mission) => options.missionId === undefined || mission.id === options.missionId,
  );
  const lines = [`# ${literal(options.projectName ?? projectId)}`, ""];
  if (options.missionId === undefined) {
    lines.push("**Intent**", "", intent?.intent ? prose(intent.intent) : "No intent yet.", "");
    if (intent !== undefined && intent.process.length > 0) {
      lines.push(`**Process**: ${steps(intent.process)}`, "");
    }
  }
  for (const mission of missions) lines.push(renderMission(mission, slicesOf(state, mission.id)));
  return document(lines);
}

export * from "./node.ts";
