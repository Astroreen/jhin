/**
 * A private prompt for a secret in a thread (docs/plans/security.md,
 * D1028–D1030): T3 Code's request_secret and SecretRequests.answer (MIT, see
 * THIRD_PARTY_NOTICES.md). The value goes to the store; the thread and the
 * agent learn only the status and a one-use secretRef.
 */
import * as Crypto from "node:crypto";

import { ThreadEvents, threadStream } from "@jhin/agent-api";
import { toDisposable, type Disposable, type PluginContext } from "@jhin/sdk";
import {
  SecretRequestAnswerInput,
  SecretRequestAnswerResult,
  SecretRequestInput,
  SecretRequestResult,
  SecretsError,
  SecretsThreadEvents,
  type SecretRequestClosed,
  type SecretRequestOpened,
  type SecretRequestStatus,
  type SecretStore,
} from "@jhin/secrets-api";
import type { EventLog, KeyValueStore } from "@jhin/storage-api";

const NAMESPACE = "jhin.secrets";
const pendingKey = (requestId: string) => `pending/${requestId}`;
/** T3's default wait for the user. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Answers kept for a `clientRequestId` asked again, newest last. */
const KEPT_ANSWERS = 200;

type Result =
  | { status: "saved"; secretRef: string }
  | { status: "declined" | "cancelled" | "timed_out" };

interface Pending {
  readonly requestId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly result: Promise<Result>;
  /** Closes the card once; the first close wins. */
  close(status: SecretRequestStatus, result: Result): Promise<void>;
}

const TURN_ENDS: ReadonlySet<string> = new Set([
  ThreadEvents.turnCompleted,
  ThreadEvents.turnInterrupted,
  ThreadEvents.turnFailed,
]);

/**
 * The turn running at the end of a thread, read back a page at a time:
 * `undefined` when the latest turn ended (as html.render finds its turn).
 */
async function runningTurnOf(log: EventLog, stream: string, head: number) {
  const ended = new Set<string>();
  for (let end = head; end > 0; end -= 500) {
    const page = await log.read(stream, { after: Math.max(0, end - 500), limit: 500 });
    for (const event of page.toReversed()) {
      const turnId = (event.payload as { turnId?: unknown } | null)?.turnId;
      if (typeof turnId !== "string") continue;
      if (TURN_ENDS.has(event.type)) ended.add(turnId);
      else if (event.type === ThreadEvents.turnStarted) {
        return ended.has(turnId) ? undefined : turnId;
      }
    }
  }
  return undefined;
}

export async function registerSecretRequests(
  context: PluginContext,
  store: SecretStore,
  log: EventLog,
  kv: KeyValueStore,
): Promise<void> {
  const pending = new Map<string, Pending>();
  /**
   * Requests answered or ended, newest last, with what their call returned:
   * a late answer is told so (D1029), a `clientRequestId` asked again gets the
   * same result (D1028).
   */
  const finished = new Map<string, Result>();
  /** `threadId \0 clientRequestId` → its request, and the ones being opened. */
  const byClient = new Map<string, string>();
  const opening = new Map<string, Promise<Pending>>();
  const remember = (requestId: string, result: Result) => {
    finished.set(requestId, result);
    if (finished.size > KEPT_ANSWERS) finished.delete(finished.keys().next().value!);
    if (byClient.size > KEPT_ANSWERS) byClient.delete(byClient.keys().next().value!);
  };

  const appendClosed = (threadId: string, closing: SecretRequestClosed) =>
    log.append(threadStream(threadId), [
      { type: SecretsThreadEvents.requestClosed, payload: { ...closing } },
    ]);

  // A node that stopped with cards open closes them: nobody waits for their answer.
  for (const { key, value } of await kv.list(NAMESPACE, { prefix: "pending/" })) {
    const { threadId } = value as { threadId: string };
    const requestId = key.slice("pending/".length);
    try {
      await appendClosed(threadId, { requestId, status: "cancelled" });
    } catch (error) {
      // Kept, so the next start tries again.
      context.log.warn("could not close a secret request left open", { error: String(error) });
      continue;
    }
    await kv.delete(NAMESPACE, key);
  }

  const subscriptions = new Set<Disposable>();
  context.subscriptions.add(
    toDisposable(() => {
      for (const subscription of subscriptions) subscription.dispose();
    }),
  );
  // Nobody can answer once the plugin is gone: the waiting calls end as cancelled.
  context.onDeactivate(async () => {
    for (const request of pending.values()) {
      await request.close("cancelled", { status: "cancelled" });
    }
  });

  const open = async (input: SecretRequestInput, threadId: string): Promise<Pending> => {
    const stream = threadStream(threadId);
    const ended = new Set<string>();
    let request: Pending | undefined;
    let turnId: string | undefined;
    // Watching first: a turn that ends while the card is being opened still closes it.
    const watching = log.subscribe(stream, (event) => {
      const ending = (event.payload as { turnId?: unknown } | null)?.turnId;
      if (!TURN_ENDS.has(event.type) || typeof ending !== "string") return;
      ended.add(ending);
      if (request !== undefined && ending === turnId) {
        void request.close("cancelled", { status: "cancelled" });
      }
    });
    subscriptions.add(watching);
    const unwatch = () => {
      watching.dispose();
      subscriptions.delete(watching);
    };
    try {
      const head = await log.head(stream);
      turnId = head === 0 ? undefined : await runningTurnOf(log, stream, head);
      if (turnId === undefined || ended.has(turnId)) {
        throw new SecretsError("SECRET_REQUEST_NO_TURN", { threadId });
      }
      const { thread } = (await context.commands.execute("threads.get", { threadId })) as {
        thread: { projectId: string };
      };
      const requestId = Crypto.randomUUID();
      const opened: SecretRequestOpened = {
        requestId,
        turnId,
        label: input.label,
        reason: input.reason,
        ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
      };
      let settle!: (result: Result) => void;
      const result = new Promise<Result>((resolve) => (settle = resolve));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const current: Pending = {
        requestId,
        threadId,
        projectId: thread.projectId,
        result,
        async close(status, outcome) {
          if (pending.get(requestId) !== current) return;
          pending.delete(requestId);
          remember(requestId, outcome);
          clearTimeout(timer);
          unwatch();
          try {
            await appendClosed(threadId, { requestId, status });
          } catch (error) {
            context.log.warn("could not close a secret request card", { error: String(error) });
          } finally {
            await kv.delete(NAMESPACE, pendingKey(requestId)).catch(() => false);
            settle(outcome);
          }
        },
      };
      await kv.set(NAMESPACE, pendingKey(requestId), { threadId });
      pending.set(requestId, current);
      request = current;
      timer = setTimeout(
        () => void current.close("cancelled", { status: "timed_out" }),
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      try {
        await log.append(stream, [
          { type: SecretsThreadEvents.requestOpened, payload: { ...opened } },
        ]);
      } catch (error) {
        // No card to answer: nothing of it is left behind.
        pending.delete(requestId);
        clearTimeout(timer);
        await kv.delete(NAMESPACE, pendingKey(requestId)).catch(() => false);
        throw error;
      }
      if (ended.has(turnId)) void current.close("cancelled", { status: "cancelled" });
      return current;
    } catch (error) {
      unwatch();
      throw error;
    }
  };

  context.commands.register({
    name: "secrets.request",
    title: "Request a secret from the user",
    description:
      "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. The value is kept by the node and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one (e.g. scheduler_tasks_create's signature.secretRef). It works once. Never ask for secrets in chat, and never invent one.",
    input: SecretRequestInput,
    output: SecretRequestResult,
    // It posts a card into the thread, as a message would.
    permissions: ["threads.write"],
    handler: async (input, invocation) => {
      // An agent asks in its own thread only (D1028).
      if (
        input.threadId !== undefined &&
        invocation.threadId !== undefined &&
        input.threadId !== invocation.threadId
      ) {
        throw new SecretsError("SECRET_REQUEST_OTHER_THREAD", { threadId: input.threadId });
      }
      const threadId = input.threadId ?? invocation.threadId;
      if (threadId === undefined) throw new SecretsError("SECRET_REQUEST_NO_TURN");
      const clientKey =
        input.clientRequestId === undefined
          ? undefined
          : `${threadId}\u0000${input.clientRequestId}`;
      const known = clientKey === undefined ? undefined : byClient.get(clientKey);
      if (known !== undefined) {
        const answered = finished.get(known);
        if (answered !== undefined) return answered;
        const waiting = pending.get(known);
        if (waiting !== undefined) return waiting.result;
      }
      if (clientKey === undefined) return (await open(input, threadId)).result;
      // Two calls of one id at once open one card.
      let starting = opening.get(clientKey);
      if (starting === undefined) {
        starting = open(input, threadId);
        opening.set(clientKey, starting);
        void starting
          .then((request) => byClient.set(clientKey, request.requestId))
          .catch(() => undefined)
          .finally(() => opening.delete(clientKey));
      }
      return (await starting).result;
    },
  });

  context.commands.register({
    name: "secrets.requests.answer",
    title: "Answer a secret request",
    description:
      "Answers a secret request in a thread: save keeps the value in the node's secret store under a one-use secretRef for the agent that asked; decline closes the card. The value never enters the thread.",
    input: SecretRequestAnswerInput,
    output: SecretRequestAnswerResult,
    // Agents do not hold it, so an agent cannot answer its own request (D1029).
    permissions: ["secrets.write"],
    handler: async ({ threadId, requestId, answer }) => {
      const request = pending.get(requestId);
      if (request === undefined || request.threadId !== threadId) {
        throw new SecretsError(
          finished.has(requestId) ? "SECRET_REQUEST_ANSWERED" : "SECRET_REQUEST_NOT_FOUND",
        );
      }
      if (answer.type === "decline") {
        await request.close("declined", { status: "declined" });
        return { status: "declined" as const };
      }
      // Stored first: the card says saved only once the value is kept.
      const secretRef = store.putRef(answer.secret, {
        projectId: request.projectId,
        threadId,
      });
      await request.close("saved", { status: "saved", secretRef });
      return { status: "saved" as const };
    },
  });
}
