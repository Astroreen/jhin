// The work-log summary follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/client-runtime/src/work-log/presentation.ts.
import {
  ThreadEvents,
  type AgentRequest,
  type AgentResponse,
  type MessageContext,
  type PlanStep,
  type TokenUsage,
  type ToolCall,
  type TurnAttachment,
} from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";

type TurnState = "running" | "completed" | "interrupted" | "failed";

export interface MessageItem {
  readonly kind: "message";
  readonly itemId: string;
  readonly text: string;
  readonly completed: boolean;
  readonly at: string;
}

interface ReasoningItem {
  readonly kind: "reasoning";
  readonly itemId: string;
  readonly text: string;
  readonly completed: boolean;
  readonly at: string;
}

export interface ToolItem {
  readonly kind: "tool";
  readonly itemId: string;
  readonly tool: ToolCall;
  readonly output: string;
  readonly status: "running" | "completed" | "failed" | "declined";
  readonly error?: string;
  readonly at: string;
  readonly endedAt?: string;
}

/** Something the agent asked the user; open until answered or until its turn ends. */
export interface RequestItem {
  readonly kind: "request";
  readonly requestId: string;
  readonly request: AgentRequest;
  readonly state: "open" | "answered" | "closed";
  readonly response?: AgentResponse;
  readonly at: string;
}

export interface PlanItem {
  readonly kind: "plan";
  readonly steps: readonly PlanStep[];
  readonly at: string;
}

/** A plan the agent proposed for the user to accept (plan mode, D304). */
export interface ProposedPlanItem {
  readonly kind: "proposed-plan";
  readonly itemId: string;
  readonly markdown: string;
  readonly at: string;
}

/** A message the user steered into the running turn (D205): a user message inside the turn. */
interface SteerItem {
  readonly kind: "steer";
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly TurnAttachment[];
  /** The context records its text names (D1006). */
  readonly context?: MessageContext;
  readonly at: string;
}

/**
 * An event another plugin put into the thread (`preview.html.rendered`): it
 * stays where it came among the agent's output and is rendered through the
 * `chat.turn.item` slot (D407).
 */
export interface ExtensionItem {
  readonly kind: "extension";
  readonly event: StoredEvent;
  readonly at: string;
}

/** Event types of other plugins: neither the threads plugin's nor the agent's. */
const isExtensionEvent = (type: string) =>
  (!type.startsWith("agent.") && !type.startsWith("threads.")) ||
  // A subagent of the turn is shown by whoever shows subagents (D879).
  type === ThreadEvents.subagentStarted;

type TimelineItem =
  | ExtensionItem
  | MessageItem
  | ReasoningItem
  | ToolItem
  | RequestItem
  | PlanItem
  | ProposedPlanItem
  | SteerItem;

/** A message waiting in the thread's queue on its node (D201), as the stream announces it. */
interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  /**
   * Attachments by name and type, an upload with its id and size too (its
   * thumbnail reads it); `threads.queue.list` has a data URL's data.
   */
  readonly attachments: readonly {
    readonly kind: "image" | "file";
    readonly name: string;
    readonly mimeType: string;
    readonly id?: string;
    readonly sizeBytes?: number;
  }[];
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly createdAt: string;
}

/** The thread's queue: its messages in order, and why it waits, if it does (D202). */
export interface ThreadQueue {
  readonly messages: readonly QueuedMessage[];
  readonly held?: {
    readonly reason: "interrupted" | "failed" | "refused";
    readonly turnId?: string;
    readonly error?: string;
  };
}

const EMPTY_QUEUE: ThreadQueue = { messages: [] };

export interface TimelineTurn {
  readonly turnId: string;
  readonly agentId: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly text: string;
  readonly attachments: readonly TurnAttachment[];
  /** The context records its text names (D1006). */
  readonly context?: MessageContext;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly state: TurnState;
  readonly error?: string;
  /** The agent's output in the order it came. A plan stays where it first appeared. */
  readonly items: readonly TimelineItem[];
  readonly usage?: TokenUsage;
  /** A fork merged back that the agent got before this message (D226). */
  readonly handoff?: { readonly kind: "merge-back"; readonly threadId: string };
}

export interface Timeline {
  readonly turns: readonly TimelineTurn[];
  /** The thread was deleted on its node. */
  readonly deleted: boolean;
  /** What waits in the thread's queue; empty when nothing does. */
  readonly queue?: ThreadQueue;
  /** A fork: its parent, and the turn it was forked after (D225). */
  readonly forkedFrom?: { readonly threadId: string; readonly turnId: string };
}

interface Payload {
  readonly turnId?: string;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
  readonly kind?: string;
  readonly input?: {
    readonly text?: string;
    readonly attachments?: readonly TurnAttachment[];
    readonly context?: MessageContext;
  };
  readonly text?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly status?: string;
  readonly output?: string;
  readonly tool?: ToolCall;
  readonly request?: AgentRequest;
  readonly response?: AgentResponse;
  readonly steps?: readonly PlanStep[];
  readonly markdown?: string;
  readonly usage?: TokenUsage;
  readonly messageId?: string;
  readonly messages?: readonly QueuedMessage[];
  readonly held?: ThreadQueue["held"];
  /** The turns a rollback dropped. */
  readonly turnIds?: readonly string[];
  /** A fork's parent; the time of an event copied into a fork. */
  readonly threadId?: string;
  readonly inheritedAt?: string;
  readonly handoff?: { readonly kind?: string; readonly threadId?: string };
}

/**
 * Claude Code's proposed plans before they had an item of their own (D304)
 * were its messages with this item id suffix (`<tool use id>:plan`).
 */
const LEGACY_PLAN_SUFFIX = ":plan";
const LEGACY_PLAN_AGENT = "jhin.agent-claude";

type MutableTurn = { -readonly [K in keyof TimelineTurn]: TimelineTurn[K] } & {
  items: TimelineItem[];
};

/** Folds a thread's events into turns, in order. Unknown event types are ignored. */
export function reduceTimeline(events: readonly StoredEvent[]): Timeline {
  return createTimeline().apply(events);
}

/**
 * A thread's timeline, folded as its events arrive: each batch costs what it
 * holds, not the whole thread again. Every `apply` returns a new timeline in
 * which only the turns the batch changed are new objects, so views of the
 * others need not render again.
 */
export function createTimeline() {
  const turns: MutableTurn[] = [];
  const byId = new Map<string, MutableTurn>();
  /** Where each item of a turn is, by item id (requests by request id). */
  const positions = new Map<MutableTurn, Map<string, number>>();
  /** The last snapshot of each turn, kept while it does not change. */
  const snapshots = new Map<MutableTurn, TimelineTurn>();
  /** The turns the batch being applied changed. */
  const changed = new Set<MutableTurn>();
  /** The last event folded in: events delivered again are not folded twice. */
  let sequence = 0;
  let deleted = false;
  let queue = EMPTY_QUEUE;
  let forkedFrom: Timeline["forkedFrom"];
  let timeline: Timeline = { turns: [], deleted: false, queue };

  const find = (turn: MutableTurn, key: string): TimelineItem | undefined => {
    const index = positions.get(turn)?.get(key);
    return index === undefined ? undefined : turn.items[index];
  };
  const put = (turn: MutableTurn, key: string | undefined, item: TimelineItem) => {
    changed.add(turn);
    const index = key === undefined ? undefined : positions.get(turn)?.get(key);
    if (index !== undefined) {
      turn.items[index] = item;
      return;
    }
    turn.items.push(item);
    if (key !== undefined) positions.get(turn)?.set(key, turn.items.length - 1);
  };

  function apply(events: readonly StoredEvent[]): Timeline {
    changed.clear();
    const wasDeleted = deleted;
    const queued = queue;
    const wasForked = forkedFrom;
    let dropped = false;
    for (const event of events) {
      if (event.sequence <= sequence) continue;
      sequence = event.sequence;
      if (event.type === ThreadEvents.threadDeleted) {
        deleted = true;
        continue;
      }
      const payload = (event.payload ?? {}) as Payload;
      if (event.type === ThreadEvents.queueUpdated) {
        queue = {
          messages: payload.messages ?? [],
          ...(payload.held === undefined ? {} : { held: payload.held }),
        };
        continue;
      }
      // A fork's copy of its parent's events keeps their times.
      const at = payload.inheritedAt ?? event.at;
      if (event.type === ThreadEvents.threadForked) {
        if (payload.threadId !== undefined && payload.turnId !== undefined) {
          forkedFrom = { threadId: payload.threadId, turnId: payload.turnId };
        }
        continue;
      }
      if (event.type === ThreadEvents.threadRolledBack) {
        // The turns a rollback dropped leave the timeline (D221).
        const ids = new Set(payload.turnIds ?? []);
        for (let index = turns.length - 1; index >= 0; index--) {
          const turn = turns[index]!;
          if (!ids.has(turn.turnId)) continue;
          turns.splice(index, 1);
          byId.delete(turn.turnId);
          positions.delete(turn);
          snapshots.delete(turn);
          changed.delete(turn);
          dropped = true;
        }
        continue;
      }
      if (event.type === ThreadEvents.turnStarted) {
        if (payload.turnId === undefined) continue;
        const turn: MutableTurn = {
          turnId: payload.turnId,
          agentId: payload.agentId ?? "",
          ...(payload.model === undefined ? {} : { model: payload.model }),
          ...(payload.runtimeMode === undefined ? {} : { runtimeMode: payload.runtimeMode }),
          ...(payload.interactionMode === undefined
            ? {}
            : { interactionMode: payload.interactionMode }),
          text: payload.input?.text ?? "",
          attachments: payload.input?.attachments ?? [],
          ...(payload.input?.context === undefined ? {} : { context: payload.input.context }),
          // A merge into the parent is the parent's: a fork's copy of that turn shows none.
          ...(payload.inheritedAt === undefined &&
          payload.handoff?.kind === "merge-back" &&
          payload.handoff.threadId !== undefined
            ? { handoff: { kind: "merge-back" as const, threadId: payload.handoff.threadId } }
            : {}),
          startedAt: at,
          state: "running",
          items: [],
        };
        byId.set(turn.turnId, turn);
        positions.set(turn, new Map());
        turns.push(turn);
        changed.add(turn);
        continue;
      }
      const extension = isExtensionEvent(event.type);
      // An event of another plugin without a turn belongs to the thread's latest one.
      const turn =
        payload.turnId === undefined
          ? extension
            ? turns.at(-1)
            : undefined
          : byId.get(payload.turnId);
      if (turn === undefined) continue;
      if (extension) {
        put(turn, `extension:${event.sequence}`, { kind: "extension", event, at });
        continue;
      }
      const itemId = payload.itemId;
      switch (event.type) {
        case ThreadEvents.turnSteered: {
          if (payload.messageId === undefined) break;
          put(turn, `steer:${payload.messageId}`, {
            kind: "steer",
            messageId: payload.messageId,
            text: payload.input?.text ?? "",
            attachments: payload.input?.attachments ?? [],
            ...(payload.input?.context === undefined ? {} : { context: payload.input.context }),
            at: event.at,
          });
          break;
        }
        case ThreadEvents.itemStarted: {
          if (itemId === undefined || payload.tool === undefined) break;
          put(turn, itemId, {
            kind: "tool",
            itemId,
            tool: payload.tool,
            output: "",
            status: "running",
            at,
          });
          break;
        }
        case ThreadEvents.itemDelta: {
          if (itemId === undefined) break;
          const text = payload.text ?? "";
          const existing = find(turn, itemId);
          if (payload.kind === "tool") {
            if (existing?.kind === "tool") {
              put(turn, itemId, { ...existing, output: existing.output + text });
            }
            break;
          }
          const kind = payload.kind === "reasoning" ? "reasoning" : "message";
          if (existing !== undefined && existing.kind === kind) {
            put(turn, itemId, { ...existing, text: existing.text + text });
          } else if (existing === undefined) {
            put(turn, itemId, { kind, itemId, text, completed: false, at: at });
          }
          break;
        }
        case ThreadEvents.itemCompleted: {
          if (itemId === undefined) break;
          const existing = find(turn, itemId);
          if (payload.kind === "tool") {
            if (existing?.kind !== "tool") break;
            const status =
              payload.status === "failed" || payload.status === "declined"
                ? payload.status
                : "completed";
            put(turn, itemId, {
              ...existing,
              status,
              output: payload.output ?? existing.output,
              ...(payload.error === undefined ? {} : { error: payload.error }),
              endedAt: at,
            });
            break;
          }
          const kind = payload.kind === "reasoning" ? "reasoning" : "message";
          if (
            kind === "message" &&
            existing === undefined &&
            turn.agentId === LEGACY_PLAN_AGENT &&
            itemId.endsWith(LEGACY_PLAN_SUFFIX) &&
            payload.text !== undefined
          ) {
            put(turn, itemId, {
              kind: "proposed-plan",
              itemId,
              markdown: payload.text,
              at: event.at,
            });
            break;
          }
          put(turn, itemId, {
            kind,
            itemId,
            text:
              payload.text ??
              (existing !== undefined && existing.kind === kind ? existing.text : ""),
            completed: true,
            at: existing?.at ?? at,
          } as MessageItem | ReasoningItem);
          break;
        }
        case ThreadEvents.requestOpened: {
          if (payload.requestId === undefined || payload.request === undefined) break;
          put(turn, `request:${payload.requestId}`, {
            kind: "request",
            requestId: payload.requestId,
            request: payload.request,
            state: "open",
            at,
          });
          break;
        }
        case ThreadEvents.requestResolved: {
          if (payload.requestId === undefined) break;
          const key = `request:${payload.requestId}`;
          const existing = find(turn, key);
          if (existing?.kind !== "request") break;
          if (payload.response !== undefined) {
            put(turn, key, { ...existing, state: "answered", response: payload.response });
            break;
          }
          // Closed, also after an answer the turn's end overtook: the agent never
          // got it (D56), so it shows unanswered.
          const { response: _response, ...unanswered } = existing;
          put(turn, key, { ...unanswered, state: "closed" });
          break;
        }
        case ThreadEvents.planUpdated: {
          const existing = find(turn, "plan");
          put(turn, "plan", {
            kind: "plan",
            steps: payload.steps ?? [],
            at: existing?.at ?? at,
          });
          break;
        }
        case ThreadEvents.planProposed: {
          if (itemId === undefined || payload.markdown === undefined) break;
          put(turn, itemId, {
            kind: "proposed-plan",
            itemId,
            markdown: payload.markdown,
            at: find(turn, itemId)?.at ?? event.at,
          });
          break;
        }
        case ThreadEvents.usageUpdated:
          if (payload.usage === undefined) break;
          turn.usage = payload.usage;
          changed.add(turn);
          break;
        case ThreadEvents.turnCompleted:
          turn.state = "completed";
          turn.endedAt = at;
          changed.add(turn);
          break;
        case ThreadEvents.turnInterrupted:
          turn.state = "interrupted";
          turn.endedAt = at;
          if (payload.reason !== undefined) turn.error = payload.reason;
          changed.add(turn);
          break;
        case ThreadEvents.turnFailed:
          turn.state = "failed";
          turn.endedAt = at;
          if (payload.error !== undefined) turn.error = payload.error;
          changed.add(turn);
          break;
      }
    }
    // Nothing this batch held changed anything: the same timeline.
    if (
      changed.size === 0 &&
      deleted === wasDeleted &&
      queue === queued &&
      !dropped &&
      forkedFrom === wasForked
    ) {
      return timeline;
    }
    for (const turn of changed) {
      // A turn that ended with a request still open never got it answered.
      const items =
        turn.state === "running"
          ? [...turn.items]
          : turn.items.map((item) =>
              item.kind === "request" && item.state === "open"
                ? { ...item, state: "closed" as const }
                : item,
            );
      snapshots.set(turn, { ...turn, items });
    }
    timeline = {
      turns: turns.map((turn) => snapshots.get(turn)!),
      deleted,
      queue,
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    };
    return timeline;
  }

  return { apply, current: () => timeline };
}

/** The open requests of the running turn: what the composer asks the user to answer. */
export function openRequests(timeline: Timeline): RequestItem[] {
  const last = timeline.turns.at(-1);
  if (last === undefined || last.state !== "running") return [];
  return last.items.filter(
    (item): item is RequestItem => item.kind === "request" && item.state === "open",
  );
}

/**
 * The plan the composer can implement (T3's `findLatestProposedPlan` and
 * `shouldShowPlanFollowUpPrompt`): the latest one the thread's latest turn
 * proposed, once that turn ended without a failure.
 */
export function actionablePlan(timeline: Timeline): ProposedPlanItem | undefined {
  const last = timeline.turns.at(-1);
  if (last === undefined || last.state === "running" || last.state === "failed") return undefined;
  return last.items.findLast((item): item is ProposedPlanItem => item.kind === "proposed-plan");
}

/** Work entries: what the work log lists between messages. */
export type WorkEntry = ReasoningItem | ToolItem | RequestItem;

export type TurnBlock =
  | { readonly kind: "message"; readonly item: MessageItem; readonly final: boolean }
  | { readonly kind: "work"; readonly entries: readonly WorkEntry[] }
  | { readonly kind: "plan"; readonly item: PlanItem }
  | { readonly kind: "proposed-plan"; readonly item: ProposedPlanItem }
  | { readonly kind: "steer"; readonly item: SteerItem }
  | { readonly kind: "extension"; readonly item: ExtensionItem };

/**
 * A turn's items as rendered: consecutive work entries become one work block;
 * open requests are left to the composer. The last message of a turn that
 * ended is its final answer.
 */
export function turnBlocks(turn: TimelineTurn): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  let work: WorkEntry[] = [];
  const flush = () => {
    if (work.length > 0) blocks.push({ kind: "work", entries: work });
    work = [];
  };
  const lastMessage = turn.items.findLast((item) => item.kind === "message");
  for (const item of turn.items) {
    if (item.kind === "message") {
      flush();
      blocks.push({
        kind: "message",
        item,
        final: turn.state !== "running" && item === lastMessage,
      });
    } else if (item.kind === "plan") {
      flush();
      blocks.push({ kind: "plan", item });
    } else if (item.kind === "proposed-plan") {
      flush();
      blocks.push({ kind: "proposed-plan", item });
    } else if (item.kind === "steer") {
      flush();
      blocks.push({ kind: "steer", item });
    } else if (item.kind === "extension") {
      flush();
      blocks.push({ kind: "extension", item });
    } else if (item.kind === "request" && item.state === "open") {
      continue;
    } else {
      work.push(item);
    }
  }
  flush();
  return blocks;
}

/**
 * The extension events each one stands among (D1161), by sequence: those of
 * the turn with only the agent's work between them. A message, a plan or a
 * steer starts another group. A plugin that shows several as one (T3's
 * "N subagents") reads them from here.
 */
export function adjacentExtensions(
  blocks: readonly TurnBlock[],
): ReadonlyMap<number, readonly StoredEvent[]> {
  const byEvent = new Map<number, readonly StoredEvent[]>();
  let group: StoredEvent[] = [];
  const close = () => {
    const done: readonly StoredEvent[] = group;
    for (const event of done) byEvent.set(event.sequence, done);
    group = [];
  };
  for (const block of blocks) {
    if (block.kind === "work") continue;
    if (block.kind !== "extension") close();
    else group.push(block.item.event);
  }
  close();
  return byEvent;
}

/**
 * Whether a settled turn folds: everything before its final answer hides
 * behind "Worked for …". A failed turn, or one with no final answer, shows all.
 */
export function foldsBeforeFinal(turn: TimelineTurn): boolean {
  if (turn.state === "running" || turn.state === "failed") return false;
  const blocks = turnBlocks(turn);
  const finalIndex = blocks.findIndex((block) => block.kind === "message" && block.final);
  return finalIndex > 0;
}

type SummaryAction = "read" | "edit" | "command" | "web" | "code-search" | "request" | "other";

function actionOf(entry: WorkEntry): SummaryAction {
  if (entry.kind === "request") return "request";
  if (entry.kind !== "tool") return "other";
  switch (entry.tool.kind) {
    case "file_read":
      return "read";
    case "file_change":
      return "edit";
    case "command":
      return "command";
    case "web":
      return "web";
    case "search":
      return "code-search";
    default:
      return "other";
  }
}

function actionLabel(action: SummaryAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "web":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "request":
      return `Answered ${count} ${count === 1 ? "request" : "requests"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
  }
}

const actionPriority = (action: SummaryAction) =>
  action === "command" || action === "edit" ? 0 : action === "other" ? 2 : 1;

/** "Ran 2 commands and read 3 files", "Thought (×2)": the header of a group of work entries. */
export function summarizeWork(entries: readonly WorkEntry[]): {
  summary: string;
  hasFailure: boolean;
} {
  const work = entries.filter((entry) => entry.kind !== "reasoning");
  if (entries.length > 0 && work.length === 0) {
    return {
      summary: entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
    };
  }
  const groups = new Map<SummaryAction, WorkEntry[]>();
  for (const entry of work) {
    const action = actionOf(entry);
    groups.set(action, [...(groups.get(action) ?? []), entry]);
  }
  const summaries = [...groups].map(([action, group], index) => {
    // Edits count files, not edits.
    const count =
      action === "edit"
        ? new Set(group.map((entry) => (entry.kind === "tool" ? entry.tool.detail : ""))).size
        : group.length;
    return { action, index, count: group.length, label: actionLabel(action, count) };
  });
  const selected = summaries
    .toSorted((a, b) => actionPriority(a.action) - actionPriority(b.action) || a.index - b.index)
    .slice(0, 2)
    .toSorted((a, b) => a.index - b.index);
  const labels = selected.map((entry) => entry.label);
  const remaining = work.length - selected.reduce((sum, entry) => sum + entry.count, 0);
  if (remaining > 0)
    labels.push(`Performed ${remaining} other ${remaining === 1 ? "action" : "actions"}`);
  const sentence = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary =
    sentence.length < 3
      ? sentence.join(" and ")
      : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
  return {
    summary,
    hasFailure: work.some((entry) => entry.kind === "tool" && entry.status === "failed"),
  };
}

const firstWord = (line: string) => line.trim().split(/\s+/)[0] ?? "";

/** The one-line label of a work entry: "Ran npm", "Running npm", "Edited src/a.ts", "Thought". */
export function workEntryLabel(entry: WorkEntry): string {
  if (entry.kind === "reasoning") {
    const preview = entry.text.replace(/\s+/g, " ").trim();
    return preview === "" ? (entry.completed ? "Thought" : "Thinking") : preview;
  }
  if (entry.kind === "request") {
    if (entry.request.kind === "approval") {
      const verdict =
        entry.state === "closed"
          ? "Unanswered"
          : entry.response?.kind === "approval" &&
              (entry.response.decision === "accept" ||
                entry.response.decision === "accept-for-session")
            ? "Approved"
            : "Declined";
      return `${verdict}: ${entry.request.tool.detail ?? entry.request.tool.title}`;
    }
    return entry.request.questions.map((question) => question.question).join(" · ");
  }
  const { tool } = entry;
  if (tool.kind === "command") {
    const program = firstWord(tool.detail ?? "") || tool.name;
    switch (entry.status) {
      case "running":
        return `Running ${program}`;
      case "failed":
        return `Failed ${program}`;
      case "declined":
        return `Declined ${program}`;
      case "completed":
        return `Ran ${program}`;
    }
  }
  if (tool.detail !== undefined && tool.detail !== "") {
    const verb =
      tool.kind === "file_read"
        ? "Read"
        : tool.kind === "file_change"
          ? "Edited"
          : tool.kind === "search"
            ? "Searched"
            : tool.kind === "web"
              ? "Searched the web for"
              : tool.title;
    return `${verb} ${tool.detail}`;
  }
  return tool.title;
}

/** The answers given to a user-input request, by question, for display. */
export function answerPreview(entry: RequestItem): string {
  if (entry.response?.kind !== "user-input") return "";
  return Object.values(entry.response.answers)
    .map((answer) => (Array.isArray(answer) ? answer.join(", ") : String(answer)))
    .join(" · ");
}
