// Derived from T3 Code (https://github.com/pingdotgg/t3code),
// packages/provider-opencode/src/server/v2/adapter.ts at eb7b35ac: a turn on an OpenCode 2
// session (startTurn, submit, onTurnEvent, onPermissionAsked, onFormCreated,
// respondToRuntimeRequest, interruptTurn), rewritten without Effect for Jhin's agent.runtime@1.
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import type { AgentItem, AgentResponse, AgentTurn, TurnRequest } from "@jhin/agent-api";
import { DEFAULT_RUNTIME_MODE, ThreadEvents, historyTranscript } from "@jhin/agent-api";

import {
  OpenCodeError,
  realClock,
  type Clock,
  type PermissionRule,
  type SessionInfo,
  type StreamEvent,
} from "./client.ts";
import {
  DECLINED,
  agentFor,
  agentPaths,
  commandOf,
  contentText,
  declinedNote,
  formAnswer,
  formQuestions,
  isSilentTool,
  isStepTokens,
  malformedModel,
  parseModel,
  permissionTool,
  sameModel,
  sameRules,
  sessionRules,
  todoSteps,
  toolCall,
  turnPromptId,
  unsupportedForm,
  usageOf,
  type Form,
  type StepTokens,
} from "./mapping.ts";
import type { Connection, ServerOwner } from "./server.ts";

/** The runtime's agent id, recorded on OpenCode's turns (D325). */
export const OPENCODE_AGENT_ID = "jhin.agent-opencode";

export const SESSION_GONE =
  "The OpenCode session no longer exists. Send the message again to continue in a new session.";
export const STILL_STOPPING =
  "OpenCode is still stopping the previous turn. Send the message again in a moment.";
export const STREAM_LOST = "The OpenCode event stream was lost.";
const UNANSWERED = "OpenCode is waiting on a request Jhin couldn't answer.";

/** Refusals that mean OpenCode queued nothing, so the session is settled (D338). */
const CLEAR_REJECTIONS = new Set([
  "InvalidRequestError",
  "ConflictError",
  "UnauthorizedError",
  "CommandNotFoundError",
  "SkillNotFoundError",
]);

const INTERRUPT_TIMEOUT_MS = 10_000;
/** How long OpenCode may take to answer a prompt (it queues it and answers at once). */
const PROMPT_TIMEOUT_MS = 60_000;
/** Tool output kept in the thread's log; longer output is cut. */
const MAX_TOOL_OUTPUT = 20_000;

/**
 * A thread's OpenCode session, kept in storage so it survives a reload and a restart: its id,
 * whether its last execution may still run (D337), and the accept-for-session grants (D331).
 */
export interface SessionRecord {
  readonly id: string;
  readonly unsettled?: boolean;
  /** No prompt of the thread reached it yet: the next one still carries the transcript. */
  readonly fresh?: boolean;
  readonly grants?: readonly PermissionRule[];
  /** The last turn whose prompt OpenCode took on it (D222's check after a rollback). */
  readonly turnId?: string;
}

/** Which OpenCode session each thread has. */
export interface SessionStore {
  get(threadId: string): Promise<SessionRecord | undefined>;
  set(threadId: string, record: SessionRecord): Promise<void>;
  delete(threadId: string): Promise<void>;
}

export interface OpenCodeTurnDependencies {
  readonly server: ServerOwner;
  readonly sessions: SessionStore;
  /** The model of a turn that names none: the config's, else OpenCode's (D335). */
  readonly defaultModel: (connection: Connection, directory: string) => Promise<string>;
  /** The model's context window, read from OpenCode's model list when not known yet. */
  readonly contextWindow: (
    connection: Connection,
    directory: string,
    model: string,
  ) => Promise<number | undefined>;
  /** Where attached images are written for OpenCode to read. */
  readonly attachmentsDir?: string;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
  /** The prompt's and the interrupt's time limits; tests pass one they fire themselves. */
  readonly clock?: Clock;
}

/** A queue of items read by one consumer; `end` closes it, with an error to fail it. */
function channel<T>() {
  const buffer: T[] = [];
  let closed = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  return {
    push(value: T) {
      if (closed) return;
      buffer.push(value);
      wake?.();
    },
    end(error?: { error: unknown }) {
      if (closed) return;
      closed = true;
      failure = error;
      wake?.();
    },
    async *read(): AsyncGenerator<T> {
      for (;;) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
          continue;
        }
        if (closed) {
          if (failure !== undefined) throw failure.error;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Writes the turn's images to files and names them in the text, as T3 does. */
async function withAttachments(
  text: string,
  request: TurnRequest,
  folder: string,
): Promise<string> {
  const attachments = request.input.attachments ?? [];
  if (attachments.length === 0) return text;
  // Private to the node's user: the folder sits in the shared temporary directory.
  await Fs.mkdir(folder, { recursive: true, mode: 0o700 });
  let result = text;
  for (const [index, attachment] of attachments.entries()) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.dataUrl);
    if (match === null) continue;
    const base = Path.basename(attachment.name).replaceAll(/[^\w.-]/g, "_") || "image";
    const file = Path.join(
      folder,
      `${index + 1}-${Path.extname(base) === "" ? `${base}${IMAGE_EXTENSIONS[match[1]!] ?? ""}` : base}`,
    );
    await Fs.writeFile(file, Buffer.from(match[2]!, "base64"), { mode: 0o600 });
    const note = `[Attached ${attachment.kind} "${attachment.name}" is saved at: ${file}]`;
    result = result.length === 0 ? note : `${result}\n\n${note}`;
  }
  return result;
}

/** A folder name for an id: distinct ids never share one (`a:b` and `a/b` do not). */
const safeName = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** Where a thread's attached images are kept until the thread is deleted. */
export function attachmentsOf(threadId: string, dir?: string): string {
  return Path.join(dir ?? Path.join(Os.tmpdir(), "jhin-opencode"), safeName(threadId));
}

const errorTag = (error: unknown) => (error instanceof OpenCodeError ? error.tag : undefined);

/** Runs one turn of a thread on its OpenCode session; `done` settles once it let go. */
export function openCodeTurn(
  request: TurnRequest,
  deps: OpenCodeTurnDependencies,
): AgentTurn & { readonly done: Promise<void> } {
  const out = channel<AgentItem>();
  const clock = deps.clock ?? realClock;
  const runtimeMode = request.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = request.interactionMode ?? "default";
  let interrupted = false;
  /** Set just before the prompt goes out: from then on the session's events are the turn's. */
  let listening = false;
  /**
   * Whether an execution end counts. On a session whose last execution may have outlived
   * its turn (unsettled) only after this turn's own start: an end before it is a late one
   * of that execution (T3's awaitingStart). Any other session has no such execution.
   */
  let executing = true;
  /** Set while OpenCode has not answered the prompt: an interrupt then waits for the answer. */
  let prompting = false;
  /** Set once OpenCode took the prompt: an interrupt stops its execution. */
  let sent = false;
  /** Answers every open request when the turn is interrupted. */
  let cancelOpen: (() => void) | undefined;
  /** Ends the wait for OpenCode's execution end. */
  let finish: ((error?: unknown) => void) | undefined;
  let stopRunning: (() => void) | undefined;

  type Pending =
    | { kind: "permission"; sessionId: string; data: PermissionAsked }
    | { kind: "form"; sessionId: string; form: Form };
  const pending = new Map<string, Pending>();
  /** The session's grants and whether its last execution may still run, as recorded. */
  let grants: PermissionRule[] = [];
  let unsettled = false;
  /** Whether the session is recorded (its first prompt went in, or an earlier turn's). */
  let saved = false;
  let fresh = false;
  let lastTurn: string | undefined;
  /** Why the turn fails when it cancelled a form Jhin cannot show (D332). */
  let declinedForm: Error | undefined;
  let save = () => {};
  let writes: Promise<unknown> = Promise.resolve();
  /** Deletes the record after any write still queued, so none writes it back. */
  const forgetRecord = () => {
    saved = false;
    writes = writes.then(() => deps.sessions.delete(request.threadId));
    return writes;
  };
  const markUnsettled = () => {
    unsettled = true;
    save();
  };
  let answer: ((requestId: string, response: AgentResponse) => void) | undefined;

  const run = async () => {
    await deps.server.use(async (connection) => {
      if (interrupted) return;
      const { client } = connection;
      const directory = request.cwd;
      const model = request.model ?? (await deps.defaultModel(connection, directory));
      const ref = parseModel(model);
      if (ref === undefined) throw new Error(malformedModel(model));
      const wanted = agentFor(interactionMode);

      // The agents' own path rules: the plan agent may write its plan file (D328).
      let paths: PermissionRule[] = [];
      if (runtimeMode !== "full-access" || interactionMode === "plan") {
        try {
          const agents = await client.agents(directory);
          const byId = new Map(agents.map((agent) => [agent.id, agentPaths(agent.permissions)]));
          const unique = new Map<string, PermissionRule>();
          for (const id of interactionMode === "plan" ? ["build", "plan"] : [wanted]) {
            for (const entry of byId.get(id) ?? []) {
              unique.set(`${entry.action}\u0000${entry.resource}`, entry);
            }
          }
          paths = [...unique.values()];
        } catch (error) {
          deps.log?.("could not list opencode agents; their path rules are skipped", {
            error: String(error),
          });
        }
      }
      const rulesFor = (sessionId: string | undefined) =>
        sessionRules(runtimeMode, interactionMode, paths, sessionId === undefined ? [] : grants);

      // --- The session -----------------------------------------------------------------
      const stored = await deps.sessions.get(request.threadId);
      // The session holds a turn the thread no longer shows (a rollback dropped it): it
      // cannot forget it, so the thread starts a new one with its transcript, as Claude's
      // does (D222). T3 reverts OpenCode's own session instead (deferred).
      const stale =
        stored?.turnId !== undefined &&
        !request.history.some(
          (event) =>
            event.type === ThreadEvents.turnStarted &&
            (event.payload as { turnId?: unknown } | null)?.turnId === stored.turnId,
        );
      if (stale) {
        deps.log?.("opencode session holds dropped turns, starting a new one", {
          threadId: request.threadId,
        });
      }
      const recorded = stale ? undefined : stored;
      lastTurn = recorded?.turnId;
      if (interrupted) return;
      let session: SessionInfo;
      let preface: string | undefined;
      if (recorded === undefined) {
        session = await client.createSession({
          location: { directory },
          model: ref,
          permissions: rulesFor(undefined),
        });
        // Recorded at once, marked fresh until OpenCode took a prompt: a turn stopped or
        // refused before that leaves the next one the session and the transcript (D327).
        fresh = true;
        saved = true;
        preface = historyTranscript(request.history);
      } else {
        try {
          session = await client.getSession(recorded.id);
        } catch (error) {
          if (errorTag(error) !== "SessionNotFoundError") throw error;
          await forgetRecord();
          throw new Error(SESSION_GONE, { cause: error });
        }
        grants = [...(recorded.grants ?? [])];
        unsettled = recorded.unsettled === true;
        fresh = recorded.fresh === true;
        saved = true;
        preface = fresh
          ? historyTranscript(request.history)
          : historyTranscript(request.history, OPENCODE_AGENT_ID);
      }
      const sessionId = session.id;
      save = () => {
        if (!saved) return;
        const record: SessionRecord = {
          id: sessionId,
          ...(unsettled ? { unsettled: true } : {}),
          ...(fresh ? { fresh: true } : {}),
          ...(lastTurn === undefined ? {} : { turnId: lastTurn }),
          ...(grants.length === 0 ? {} : { grants: [...grants] }),
        };
        writes = writes
          .then(() => deps.sessions.set(request.threadId, record))
          .catch((error: unknown) =>
            deps.log?.("could not record the opencode session", { error: String(error) }),
          );
      };
      // A new session is recorded at once, fresh until OpenCode takes a prompt.
      if (recorded === undefined) save();

      // A stopped execution may still run (D337).
      if (unsettled) {
        executing = false;
        const active = await client.active();
        if (active[sessionId] !== undefined) {
          await client.interrupt(sessionId).catch(() => undefined);
          throw new Error(STILL_STOPPING);
        }
        unsettled = false;
        save();
      }
      if ((session.agent ?? "build") !== wanted) await client.switchAgent(sessionId, wanted);
      if (!sameModel(ref, session.model)) await client.switchModel(sessionId, ref);
      const rules = rulesFor(sessionId);
      if (recorded !== undefined && !sameRules(session.permissions, rules)) {
        await client.updateSession(sessionId, { permissions: rules });
      }
      const contextWindow = await deps
        .contextWindow(connection, directory, model)
        .catch(() => undefined);
      if (interrupted) return;

      // --- Items -----------------------------------------------------------------------
      const tools = new Map<string, { name: string; input: unknown; started: boolean }>();
      const declined = new Set<string>();
      const texts = new Map<string, string>();
      const steps: StepTokens[] = [];
      let cost = 0;

      const startTool = (id: string) => {
        const tool = tools.get(id);
        if (tool === undefined || tool.started || isSilentTool(tool.name)) return;
        tool.started = true;
        out.push({ kind: "tool.started", itemId: id, tool: toolCall(tool.name, tool.input) });
      };

      const openRequest = (requestId: string, entry: Pending, item: AgentItem) => {
        // Listening before the request goes out: an answer may come before the next pull.
        pending.set(requestId, entry);
        out.push(item);
      };

      const onEvent = (event: StreamEvent) => {
        if (!listening) return;
        // After an interrupt only the execution's end counts: what OpenCode still sends
        // would make the turn look answered.
        if (interrupted && !event.type.startsWith("session.execution.")) return;
        const data = event.data;
        switch (event.type) {
          case "session.text.delta":
          case "session.reasoning.delta":
          case "session.text.ended":
          case "session.reasoning.ended": {
            const kind = event.type.startsWith("session.text.") ? "message" : "reasoning";
            const itemId = `${String(data["assistantMessageID"])}:${kind === "message" ? "text" : "reasoning"}:${String(data["ordinal"])}`;
            if (typeof data["delta"] === "string") {
              if (data["delta"].length === 0) return;
              texts.set(itemId, (texts.get(itemId) ?? "") + data["delta"]);
              out.push({ kind: `${kind}.delta`, itemId, text: data["delta"] });
              return;
            }
            const text =
              typeof data["text"] === "string" ? data["text"] : (texts.get(itemId) ?? "");
            texts.delete(itemId);
            if (text.trim().length > 0) out.push({ kind: `${kind}.completed`, itemId, text });
            return;
          }
          case "session.tool.input.started": {
            const id = String(data["id"]);
            const name = String(data["name"]);
            tools.set(id, { name, input: {}, started: false });
            return;
          }
          case "session.tool.called": {
            const id = String(data["id"]);
            const tool = tools.get(id) ?? { name: "tool", input: {}, started: false };
            tool.input = data["input"];
            tools.set(id, tool);
            if (tool.name === "todowrite") {
              const planned = todoSteps(data["input"]);
              if (planned.length > 0) out.push({ kind: "plan.updated", steps: planned });
              return;
            }
            startTool(id);
            return;
          }
          case "session.tool.success":
          case "session.tool.failed": {
            const id = String(data["id"]);
            const tool = tools.get(id);
            if (tool !== undefined && isSilentTool(tool.name)) return;
            const failed = event.type === "session.tool.failed";
            const error = data["error"] as { type?: unknown; message?: unknown } | undefined;
            if (tool === undefined) tools.set(id, { name: "tool", input: {}, started: false });
            startTool(id);
            const text = failed
              ? typeof error?.message === "string"
                ? error.message
                : contentText(data["content"])
              : contentText(data["content"]);
            const output =
              text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…` : text;
            const status = declined.has(id) ? "declined" : failed ? "failed" : "completed";
            out.push({
              kind: "tool.completed",
              itemId: id,
              status,
              ...(output.length === 0 ? {} : status === "failed" ? { error: output } : { output }),
            });
            return;
          }
          case "session.compaction.started": {
            out.push({
              kind: "tool.started",
              itemId: `${request.turnId}:compaction`,
              tool: { name: "compaction", kind: "other", title: "Compacting context" },
            });
            return;
          }
          case "session.compaction.ended":
          case "session.compaction.failed": {
            const failed = event.type === "session.compaction.failed";
            const text = typeof data["text"] === "string" ? data["text"] : "";
            out.push({
              kind: "tool.completed",
              itemId: `${request.turnId}:compaction`,
              status: failed ? "failed" : "completed",
              ...(failed
                ? { error: "Compaction failed" }
                : text.length === 0
                  ? {}
                  : { output: text }),
            });
            return;
          }
          case "session.step.ended":
          case "session.step.failed": {
            if (!isStepTokens(data["tokens"])) return;
            steps.push(data["tokens"]);
            if (typeof data["cost"] === "number") cost += data["cost"];
            out.push({ kind: "usage", usage: usageOf(steps, cost, contextWindow) });
            return;
          }
          case "permission.asked": {
            const asked = data as unknown as PermissionAsked;
            const source = asked.source?.id;
            const tool = source === undefined ? undefined : tools.get(source);
            const resources = asked.resources ?? [];
            openRequest(
              asked.id,
              { kind: "permission", sessionId: asked.sessionID, data: asked },
              {
                kind: "request.opened",
                requestId: asked.id,
                request: {
                  kind: "approval",
                  tool:
                    tool === undefined || isSilentTool(tool.name)
                      ? permissionTool(asked.action, resources, tool?.name)
                      : {
                          ...toolCall(tool.name, tool.input, true),
                          ...(resources.length === 0 ? {} : { detail: resources.join("\n") }),
                        },
                  ...(asked.message === undefined ? {} : { reason: asked.message }),
                },
              },
            );
            return;
          }
          case "form.created": {
            const form = data["form"] as Form | undefined;
            if (form === undefined) return;
            const mapped = formQuestions(form);
            if ("questions" in mapped) {
              openRequest(
                form.id,
                { kind: "form", sessionId: form.sessionID, form },
                {
                  kind: "request.opened",
                  requestId: form.id,
                  request: { kind: "user-input", questions: mapped.questions },
                },
              );
              return;
            }
            // Cancelling ends OpenCode's execution as a user stop: the turn fails here with
            // the reason, and the stop's end belongs to no turn.
            deps.log?.("declined an opencode form jhin cannot show", {
              reason: mapped.unsupported,
            });
            markUnsettled();
            // Set before the cancel: the stop it causes may come back before its answer.
            declinedForm = new Error(unsupportedForm(mapped.unsupported));
            const failed = finish;
            void client
              .cancelForm(form.sessionID, form.id)
              .catch(() => undefined)
              .then(() => failed?.(declinedForm));
            return;
          }
          case "session.execution.started":
            executing = true;
            return;
          case "session.execution.succeeded":
            if (!executing) return;
            finish?.();
            return;
          case "session.execution.interrupted":
            if (!executing) return;
            finish?.(
              interrupted ? undefined : (declinedForm ?? new Error("OpenCode stopped the turn.")),
            );
            return;
          case "session.execution.failed": {
            if (!executing) return;
            const error = data["error"] as { message?: unknown } | undefined;
            finish?.(
              new Error(
                typeof error?.message === "string" && error.message.length > 0
                  ? error.message
                  : "OpenCode failed the turn.",
              ),
            );
            return;
          }
          default:
            return;
        }
      };

      // --- Answers -----------------------------------------------------------------------
      const deliver = async (send: () => Promise<unknown>) => {
        try {
          await send();
        } catch (error) {
          const tag = errorTag(error);
          // Gone already: nothing waits for the answer.
          if (
            tag === "PermissionNotFoundError" ||
            tag === "FormNotFoundError" ||
            tag === "FormAlreadySettledError" ||
            tag === "SessionNotFoundError"
          ) {
            return;
          }
          deps.log?.("could not answer an opencode request", { error: String(error) });
          markUnsettled();
          void client.interrupt(sessionId).catch(() => undefined);
          finish?.(new Error(UNANSWERED));
        }
      };
      // An interrupt answers what is open: a reject without a message and a cancelled form
      // are OpenCode's stop, as the interrupt is.
      cancelOpen = () => {
        for (const [requestId, entry] of pending) {
          pending.delete(requestId);
          void (
            entry.kind === "permission"
              ? client.replyPermission(entry.sessionId, entry.data.id, { decision: "reject" })
              : client.cancelForm(entry.sessionId, entry.form.id)
          ).catch(() => undefined);
        }
      };
      answer = (requestId, response) => {
        const entry = pending.get(requestId);
        if (entry === undefined) return;
        pending.delete(requestId);
        if (entry.kind === "permission") {
          const asked = entry.data;
          // An answer of another kind is no decision of the user's: OpenCode's stop, unsteered.
          const decision = response.kind === "approval" ? response.decision : "cancel";
          void (async () => {
            if (decision === "accept-for-session" && (asked.save ?? []).length === 0) {
              // OpenCode named nothing to save (T3 offers no session grant then): allowed once.
              deps.log?.("opencode offered no session grant; the request is allowed once", {
                action: asked.action,
              });
            }
            if (decision === "accept-for-session" && (asked.save ?? []).length > 0) {
              for (const resource of asked.save ?? []) {
                if (!grants.some((g) => g.action === asked.action && g.resource === resource)) {
                  grants.push({ action: asked.action, resource, effect: "allow" });
                }
              }
              save();
              await client
                .updateSession(entry.sessionId, { permissions: rulesFor(entry.sessionId) })
                .catch((error: unknown) =>
                  deps.log?.("could not write the opencode session's rules", {
                    error: String(error),
                  }),
                );
            }
            if (decision === "decline") {
              if (asked.source?.id !== undefined) declined.add(asked.source.id);
              await client
                .synthetic(entry.sessionId, {
                  text: declinedNote(asked.action, asked.resources ?? []),
                  delivery: "steer",
                  resume: false,
                })
                .catch(() => undefined);
            }
            if (decision === "cancel" && asked.source?.id !== undefined) {
              declined.add(asked.source.id);
            }
            const approves = decision === "accept" || decision === "accept-for-session";
            await deliver(() =>
              client.replyPermission(entry.sessionId, asked.id, {
                decision: approves ? "once" : "reject",
                ...(decision === "decline" ? { message: DECLINED } : {}),
              }),
            );
          })();
          return;
        }
        const answers =
          response.kind === "user-input" ? formAnswer(entry.form, response.answers) : {};
        void deliver(() =>
          Object.keys(answers).length === 0
            ? client.cancelForm(entry.sessionId, entry.form.id)
            : client.replyForm(entry.sessionId, entry.form.id, answers),
        );
      };

      // --- The prompt --------------------------------------------------------------------
      const ended = new Promise<void>((resolve, reject) => {
        finish = (error) => (error === undefined ? resolve() : reject(error));
      });
      // Nothing is lost when `finish` comes before anyone waits for `ended`.
      ended.catch(() => undefined);
      const stopListening = connection.listen(sessionId, onEvent);
      const stopLost = connection.onLost((reason) => {
        markUnsettled();
        // The server's own words when it exited; "lost" when only the stream went.
        finish?.(interrupted ? undefined : new Error(reason));
      });
      // Before the prompt went out the turn just ends; while OpenCode has not answered it, the
      // stop waits for the answer (below), so a prompt taken meanwhile is stopped too.
      const promptAbort = new AbortController();
      stopRunning = () => {
        if (sent) void stop();
        else if (prompting) {
          // OpenCode has not answered the prompt: it is given up on, and as OpenCode may
          // take it after all, the session is stopped and the next turn checks first.
          promptAbort.abort();
          markUnsettled();
          void stop();
        } else finish?.();
      };
      /** The stop under way: the turn lets go of the server only after it (10 s at most). */
      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= stopExecution();
      };
      const stopExecution = async () => {
        const abort = new AbortController();
        const cancelTimer = clock.after(INTERRUPT_TIMEOUT_MS, () => abort.abort());
        try {
          const result = await client.interrupt(sessionId, abort.signal);
          // Nothing ran (yet, or any more): the turn ends now, and the next one checks that
          // nothing starts late.
          if (result?.interrupted === false) {
            markUnsettled();
            finish?.();
          }
        } catch {
          // No answer in time: the turn ends here and the next one checks first.
          markUnsettled();
          finish?.();
        } finally {
          cancelTimer();
        }
      };
      try {
        const text = await withAttachments(
          preface === undefined ? request.input.text : `${preface}${request.input.text}`,
          request,
          attachments,
        );
        if (interrupted) return;
        const command =
          preface === undefined && (request.input.attachments ?? []).length === 0
            ? commandOf(request.input.text)
            : undefined;
        listening = true;
        prompting = true;
        // A prompt OpenCode does not answer in time fails the turn instead of holding it.
        const timedOut = new AbortController();
        const cancelPromptTimer = clock.after(PROMPT_TIMEOUT_MS, () => timedOut.abort());
        const signal = AbortSignal.any([promptAbort.signal, timedOut.signal]);
        try {
          if (command?.name === "compact" && command.text.length === 0) {
            await client.compact(
              sessionId,
              { id: turnPromptId(sessionId, request.turnId) },
              signal,
            );
          } else if (
            command !== undefined &&
            // A failed lookup sends the text as it is (`/etc/hosts` is no command).
            (await client.commands(directory, signal).catch(() => [])).some(
              (entry) => entry.name === command.name,
            )
          ) {
            await client.command(sessionId, command, signal);
          } else {
            await client.prompt(
              sessionId,
              { id: turnPromptId(sessionId, request.turnId), text },
              signal,
            );
          }
        } catch (error) {
          const tag = errorTag(error);
          if (tag === "SessionNotFoundError") {
            await forgetRecord();
            throw new Error(SESSION_GONE, { cause: error });
          }
          if (signal.aborted && !promptAbort.signal.aborted) {
            markUnsettled();
            throw new Error("OpenCode did not answer the prompt in time.", { cause: error });
          }
          // OpenCode may have taken the prompt after all: the next turn checks first.
          if (tag === undefined || !CLEAR_REJECTIONS.has(tag)) markUnsettled();
          throw error instanceof Error ? new Error(error.message) : error;
        } finally {
          prompting = false;
          cancelPromptTimer();
        }
        sent = true;
        fresh = false;
        lastTurn = request.turnId;
        save();
        if (interrupted) void stop();
        await ended;
      } finally {
        await stopping;
        stopListening();
        stopLost();
        stopRunning = undefined;
        finish = undefined;
        answer = undefined;
        cancelOpen = undefined;
      }
    });
  };

  /**
   * The turn's images stay while the thread does: the session's history names their paths,
   * and later turns may refer to them. They go with the thread (`attachmentsOf`).
   */
  const attachments = Path.join(
    attachmentsOf(request.threadId, deps.attachmentsDir),
    safeName(request.turnId),
  );
  /** Runs the turn, then waits for its record writes. */
  const runAndClean = async () => {
    try {
      await run();
    } finally {
      await writes;
    }
  };

  const done = runAndClean().then(
    () => out.end(),
    (error: unknown) => {
      if (interrupted) out.end();
      else out.end({ error });
    },
  );

  return {
    done,
    items: out.read(),
    interrupt() {
      if (interrupted) return;
      interrupted = true;
      cancelOpen?.();
      pending.clear();
      stopRunning?.();
    },
    respond(requestId, response) {
      answer?.(requestId, response);
    },
  };
}

interface PermissionAsked {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources?: readonly string[];
  readonly save?: readonly string[];
  readonly source?: { readonly type: "tool"; readonly messageID: string; readonly id: string };
  readonly message?: string;
}
