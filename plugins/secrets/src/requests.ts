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
  /** Requests answered or ended, so a late answer is told so (D1029). */
  const closed = new Set<string>();
  /** `threadId \0 clientRequestId` → its request, waiting or answered (D1028). */
  const byClient = new Map<string, { requestId: string; result?: Result }>();

  const appendClosed = (threadId: string, closing: SecretRequestClosed) =>
    log.append(threadStream(threadId), [
      { type: SecretsThreadEvents.requestClosed, payload: { ...closing } },
    ]);

  // A node that stopped with cards open closes them: nobody waits for their answer.
  for (const { key, value } of await kv.list(NAMESPACE, { prefix: "pending/" })) {
    const { threadId } = value as { threadId: string };
    const requestId = key.slice("pending/".length);
    await appendClosed(threadId, { requestId, status: "cancelled" }).catch((error: unknown) =>
      context.log.warn("could not close a secret request left open", { error: String(error) }),
    );
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
    const head = await log.head(stream);
    const turnId = head === 0 ? undefined : await runningTurnOf(log, stream, head);
    if (turnId === undefined) throw new SecretsError("SECRET_REQUEST_NO_TURN", { threadId });
    const { thread } = (await context.commands.execute("threads.get", { threadId })) as {
      thread: { projectId: string };
    };
    const requestId = Crypto.randomUUID();
    await kv.set(NAMESPACE, pendingKey(requestId), { threadId });
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
    let watching: Disposable | undefined;
    const request: Pending = {
      requestId,
      threadId,
      projectId: thread.projectId,
      result,
      async close(status, outcome) {
        if (pending.get(requestId) !== request) return;
        pending.delete(requestId);
        closed.add(requestId);
        clearTimeout(timer);
        if (watching !== undefined) {
          watching.dispose();
          subscriptions.delete(watching);
        }
        try {
          await appendClosed(threadId, { requestId, status });
          await kv.delete(NAMESPACE, pendingKey(requestId));
        } finally {
          settle(outcome);
        }
      },
    };
    pending.set(requestId, request);
    // The card lives as long as the turn that asked (T3: the run).
    watching = log.subscribe(stream, (event) => {
      if (TURN_ENDS.has(event.type) && (event.payload as { turnId?: unknown })?.turnId === turnId) {
        void request.close("cancelled", { status: "cancelled" });
      }
    });
    subscriptions.add(watching);
    timer = setTimeout(
      () => void request.close("cancelled", { status: "timed_out" }),
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    await log.append(stream, [{ type: SecretsThreadEvents.requestOpened, payload: { ...opened } }]);
    return request;
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
      const threadId = input.threadId ?? invocation.threadId;
      if (threadId === undefined) throw new SecretsError("SECRET_REQUEST_NO_TURN");
      const clientKey =
        input.clientRequestId === undefined
          ? undefined
          : `${threadId}\u0000${input.clientRequestId}`;
      const known = clientKey === undefined ? undefined : byClient.get(clientKey);
      if (known?.result !== undefined) return known.result;
      const waiting = known === undefined ? undefined : pending.get(known.requestId);
      const request = waiting ?? (await open(input, threadId));
      if (clientKey !== undefined && known === undefined) {
        byClient.set(clientKey, { requestId: request.requestId });
      }
      const result = await request.result;
      if (clientKey !== undefined) {
        byClient.delete(clientKey);
        byClient.set(clientKey, { requestId: request.requestId, result });
        if (byClient.size > KEPT_ANSWERS) byClient.delete(byClient.keys().next().value!);
      }
      return result;
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
          closed.has(requestId) ? "SECRET_REQUEST_ANSWERED" : "SECRET_REQUEST_NOT_FOUND",
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
