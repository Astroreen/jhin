import {
  DisposableStore,
  missingPermissions,
  type Disposable,
  type Invocation,
  type Logger,
} from "@jhin/sdk";
import type { EventLog, StoredEvent } from "@jhin/storage-api";

import type { Peer } from "./peer.ts";
import { UNGUARDED_STREAM_PERMISSION, type LiveStreams, type StreamSource } from "./streams.ts";
import {
  AckParams,
  ErrorCodes,
  RPC_ACK,
  RPC_EVENT,
  RPC_HELLO,
  RPC_READY,
  RPC_SUBSCRIBE,
  RPC_SUBSCRIPTION_ENDED,
  RPC_UNSUBSCRIBE,
  RequestMessage,
  SubscribeParams,
  UnsubscribeParams,
  toErrorObject,
  type ErrorObject,
  type ResponseMessage,
} from "./protocol.ts";

const BACKLOG_PAGE = 500;
/**
 * Most a windowed subscription keeps waiting for acknowledgements, in JSON
 * characters: past it the subscription ends with `SUBSCRIPTION_OVERFLOW`
 * and the client reads a snapshot again (D470).
 */
export const MAX_WAITING_CHARACTERS = 16 * 1024 * 1024;

/** A subscription of the connection; a windowed one takes acknowledgements. */
interface Subscription extends Disposable {
  ack?(sequence: number): void;
}

export interface RpcServerOptions {
  /** Runs a command; usually `context.commands.execute`. */
  execute(name: string, input: unknown, invocation: Invocation): Promise<unknown>;
  /** Who is on the other end; checked by every command (D17: remote surfaces always set a caller). */
  readonly caller: NonNullable<Invocation["caller"]>;
  /** Streams clients may subscribe to; subscriptions fail without it. */
  readonly log?: EventLog;
  /** Streams served from memory (`rpc.streams@1`); a stream they serve is not read from `log`. */
  readonly streams?: Pick<LiveStreams, "sourceOf"> & Partial<Pick<LiveStreams, "guardOf">>;
  /** Payload of `rpc.hello`. */
  hello(): unknown;
  newTraceId(): string;
  /** Runs `work` with `traceId` as the current trace (log lines pick it up). */
  traced?<T>(traceId: string, work: () => Promise<T>): Promise<T>;
  readonly logger: Logger;
}

/** Serves one connection until its peer closes. */
export function serveRpc(peer: Peer, options: RpcServerOptions): Disposable {
  const store = new DisposableStore();
  const subscriptions = new Map<string, Subscription>();
  const traced = options.traced ?? (<T>(_trace: string, work: () => Promise<T>) => work());

  const reply = (message: ResponseMessage) => {
    try {
      peer.send(JSON.stringify(message));
    } catch (error) {
      // The peer closed under us; there is nobody left to answer.
      options.logger.debug("reply dropped", { error: String(error) });
    }
  };
  const fail = (id: ResponseMessage["id"], error: ErrorObject, trace?: string) =>
    reply({ jsonrpc: "2.0", id, error, ...(trace === undefined ? {} : { trace }) });

  async function subscribe(params: unknown): Promise<unknown> {
    const { subscription: id, stream, after, window } = SubscribeParams.parse(params);
    if (subscriptions.has(id)) {
      throw Object.assign(new Error(`Subscription ${id} already exists on this connection`), {
        code: "INVALID",
      });
    }
    const served = options.streams?.sourceOf(stream);
    // A stream of the event log needs what its guard says, or `events.read` (security.md D415).
    const needed = served?.permissions ??
      options.streams?.guardOf?.(stream) ?? [UNGUARDED_STREAM_PERMISSION];
    const missing = missingPermissions(options.caller.permissions, needed);
    if (missing.length > 0) {
      throw Object.assign(new Error(`Reading ${stream} needs ${missing.join(", ")}`), {
        code: "PERMISSION_DENIED",
        details: { stream, missing },
      });
    }
    const log: StreamSource | undefined = served?.source ?? options.log;
    if (log === undefined) {
      throw Object.assign(new Error("This node has no event log"), { code: "UNAVAILABLE" });
    }
    let lastSent = after;
    let live = false;
    const buffered: StoredEvent[] = [];
    // Flow control (D470): what is sent and not acknowledged, and what waits.
    const unacked: { sequence: number; size: number }[] = [];
    let unackedSize = 0;
    const waiting: { sequence: number; text: string }[] = [];
    let waitingSize = 0;
    /** Past the bound while the backlog is read: `subscribe` fails instead (no id is known yet). */
    let overflowed = false;
    let bufferedSize = 0;
    /**
     * Whether an event of `size` fits the window: at most `events` events and
     * `bytes` characters unacknowledged; one larger than the window goes
     * alone, when nothing else is unacknowledged.
     */
    const fits = (size: number) =>
      window === undefined ||
      unacked.length === 0 ||
      (unacked.length < window.events && unackedSize + size <= window.bytes);
    const send = (sequence: number, text: string) => {
      if (window !== undefined) {
        unacked.push({ sequence, size: text.length });
        unackedSize += text.length;
      }
      peer.send(text);
    };
    const deliver = (event: StoredEvent) => {
      if (event.sequence <= lastSent) return;
      lastSent = event.sequence;
      const text = JSON.stringify({
        jsonrpc: "2.0",
        method: RPC_EVENT,
        params: { subscription: id, event },
      });
      if (waiting.length === 0 && fits(text.length)) {
        send(event.sequence, text);
        return;
      }
      waiting.push({ sequence: event.sequence, text });
      waitingSize += text.length;
      if (waitingSize <= MAX_WAITING_CHARACTERS) return;
      if (live) overflow();
      else overflowed = true;
    };
    /** The subscriber fell too far behind: the subscription ends, and says why. */
    const overflow = () => {
      if (!active()) return;
      subscription.dispose();
      subscriptions.delete(id);
      waiting.length = 0;
      waitingSize = 0;
      try {
        peer.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: RPC_SUBSCRIPTION_ENDED,
            params: {
              subscription: id,
              error: {
                code: ErrorCodes.SERVER_ERROR,
                message: `Subscription ${id} to ${stream} fell too far behind`,
                data: { code: "SUBSCRIPTION_OVERFLOW", details: { stream } },
              },
            },
          }),
        );
      } catch (error) {
        // The peer closed under us: nobody is left to tell.
        options.logger.debug("subscription end not sent", { error: String(error) });
      }
    };
    const keep = (event: StoredEvent) => {
      buffered.push(event);
      if (window === undefined) return;
      bufferedSize += JSON.stringify(event).length;
      if (bufferedSize > MAX_WAITING_CHARACTERS) overflowed = true;
    };
    if (log.follow !== undefined) {
      // A source that reads elsewhere (D500): it replays and follows on its own.
      // Its events go as they come; a window is not kept here (mesh-streams.md Deferred).
      const followed = log.follow(
        stream,
        after,
        (event) => {
          if (subscriptions.get(id) !== followed || event.sequence <= lastSent) return;
          lastSent = event.sequence;
          peer.send(
            JSON.stringify({ jsonrpc: "2.0", method: RPC_EVENT, params: { subscription: id, event } }),
          );
        },
        (error) => {
          if (subscriptions.get(id) !== followed) return;
          subscriptions.delete(id);
          followed.dispose();
          try {
            peer.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: RPC_SUBSCRIPTION_ENDED,
                params: { subscription: id, error: toErrorObject(error) },
              }),
            );
          } catch {
            // The peer is gone: nobody is left to tell.
          }
        },
      );
      subscriptions.set(id, followed);
      try {
        return { subscription: id, head: await followed.ready };
      } catch (error) {
        followed.dispose();
        if (subscriptions.get(id) === followed) subscriptions.delete(id);
        throw error;
      }
    }
    // Subscribe first, then read the backlog: an event appended in between is
    // in the buffer, in the backlog, or both; `lastSent` drops duplicates.
    const live$ = log.subscribe(stream, (event) => (live ? deliver(event) : keep(event)));
    const subscription: Subscription = {
      dispose: () => live$.dispose(),
      ...(window === undefined
        ? {}
        : {
            ack(sequence: number) {
              while (unacked.length > 0 && unacked[0]!.sequence <= sequence) {
                unackedSize -= unacked.shift()!.size;
              }
              while (waiting.length > 0 && fits(waiting[0]!.text.length)) {
                const next = waiting.shift()!;
                waitingSize -= next.text.length;
                send(next.sequence, next.text);
              }
            },
          }),
    };
    subscriptions.set(id, subscription);
    // An unsubscribe (or a closed connection) while the backlog is read ends the replay.
    function active() {
      return subscriptions.get(id) === subscription;
    }
    let head: number;
    try {
      head = await log.head(stream);
      for (;;) {
        const page = await log.read(stream, { after: lastSent, limit: BACKLOG_PAGE });
        if (!active() || overflowed) break;
        for (const event of page) {
          deliver(event);
          if (overflowed) break;
        }
        if (page.length < BACKLOG_PAGE) break;
      }
    } catch (error) {
      // A failed replay leaves nothing behind, so the client can retry with the same id.
      live$.dispose();
      if (active()) subscriptions.delete(id);
      throw error;
    }
    if (active() && !overflowed) {
      for (const event of buffered) deliver(event);
      buffered.length = 0;
    }
    if (overflowed) {
      // More waits than a windowed subscriber may hold before it even started:
      // it reads a snapshot instead (D470).
      live$.dispose();
      if (active()) subscriptions.delete(id);
      throw Object.assign(new Error(`Subscription ${id} to ${stream} fell too far behind`), {
        code: "SUBSCRIPTION_OVERFLOW",
        details: { stream },
      });
    }
    if (active()) live = true;
    return { subscription: id, head };
  }

  async function handle(request: RequestMessage, trace: string): Promise<unknown> {
    switch (request.method) {
      case RPC_HELLO:
        return options.hello();
      case RPC_SUBSCRIBE:
        return subscribe(request.params);
      case RPC_UNSUBSCRIBE: {
        const { subscription } = UnsubscribeParams.parse(request.params);
        subscriptions.get(subscription)?.dispose();
        subscriptions.delete(subscription);
        return {};
      }
      default:
        return options.execute(request.method, request.params ?? {}, {
          traceId: trace,
          caller: options.caller,
        });
    }
  }

  // Tells the client it was accepted; until then it cannot tell a refused token from a slow server.
  peer.send(JSON.stringify({ jsonrpc: "2.0", method: RPC_READY, params: {} }));

  store.add(
    peer.onMessage((text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        fail(null, {
          code: ErrorCodes.PARSE_ERROR,
          message: "Message is not JSON",
          data: { code: "PARSE_ERROR" },
        });
        return;
      }
      // On a two-way link the other side's answers to our own calls arrive here
      // too; they belong to a caller (createCaller / createRpcClient), not to us.
      if (typeof raw === "object" && raw !== null && !("method" in raw)) return;
      // Notifications (no id): an acknowledgement of a windowed subscription
      // (D470); others, e.g. rpc.event for a subscription this side made, are not ours.
      if (typeof raw === "object" && raw !== null && "method" in raw && !("id" in raw)) {
        if ((raw as { method: unknown }).method !== RPC_ACK) return;
        const ack = AckParams.safeParse((raw as { params?: unknown }).params);
        if (ack.success) subscriptions.get(ack.data.subscription)?.ack?.(ack.data.sequence);
        return;
      }
      const parsed = RequestMessage.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { id?: unknown } | null)?.id;
        fail(typeof id === "string" || typeof id === "number" ? id : null, {
          code: ErrorCodes.INVALID_REQUEST,
          message: "Not a JSON-RPC 2.0 request",
          data: { code: "INVALID_REQUEST" },
        });
        return;
      }
      const request = parsed.data;
      const trace = request.trace ?? options.newTraceId();
      traced(trace, async () => {
        const started = Date.now();
        try {
          const result = await handle(request, trace);
          options.logger.debug("rpc call", { method: request.method, ms: Date.now() - started });
          reply({ jsonrpc: "2.0", id: request.id, result: result ?? null, trace });
        } catch (error) {
          const object = toErrorObject(error);
          options.logger.info("rpc call failed", { method: request.method, error: object });
          fail(request.id, object, trace);
        }
      }).catch((error: unknown) =>
        options.logger.error("rpc request crashed", {
          method: request.method,
          error: String(error),
        }),
      );
    }),
  );
  store.add(
    peer.onClose(() => {
      for (const subscription of subscriptions.values()) subscription.dispose();
      subscriptions.clear();
      store.dispose();
    }),
  );
  return {
    dispose() {
      for (const subscription of subscriptions.values()) subscription.dispose();
      subscriptions.clear();
      store.dispose();
    },
  };
}
