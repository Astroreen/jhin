import { DisposableStore, type Disposable, type Invocation, type Logger } from "@jhin/sdk";
import type { EventLog, StoredEvent } from "@jhin/storage-api";

import type { Peer } from "./peer.ts";
import {
  ErrorCodes,
  RPC_EVENT,
  RPC_HELLO,
  RPC_READY,
  RPC_SUBSCRIBE,
  RPC_UNSUBSCRIBE,
  RequestMessage,
  SubscribeParams,
  UnsubscribeParams,
  toErrorObject,
  type ErrorObject,
  type ResponseMessage,
} from "./protocol.ts";

const BACKLOG_PAGE = 500;

export interface RpcServerOptions {
  /** Runs a command; usually `context.commands.execute`. */
  execute(name: string, input: unknown, invocation: Invocation): Promise<unknown>;
  /** Who is on the other end; checked by every command (D17: remote surfaces always set a caller). */
  readonly caller: NonNullable<Invocation["caller"]>;
  /** Streams clients may subscribe to; subscriptions fail without it. */
  readonly log?: EventLog;
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
  const subscriptions = new Map<string, Disposable>();
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
    const { subscription: id, stream, after } = SubscribeParams.parse(params);
    if (subscriptions.has(id)) {
      throw Object.assign(new Error(`Subscription ${id} already exists on this connection`), {
        code: "INVALID",
      });
    }
    if (options.log === undefined) {
      throw Object.assign(new Error("This node has no event log"), { code: "UNAVAILABLE" });
    }
    const log = options.log;
    let lastSent = after;
    let live = false;
    const buffered: StoredEvent[] = [];
    const deliver = (event: StoredEvent) => {
      if (event.sequence <= lastSent) return;
      lastSent = event.sequence;
      peer.send(
        JSON.stringify({ jsonrpc: "2.0", method: RPC_EVENT, params: { subscription: id, event } }),
      );
    };
    // Subscribe first, then read the backlog: an event appended in between is
    // in the buffer, in the backlog, or both; `lastSent` drops duplicates.
    const live$ = log.subscribe(stream, (event) => (live ? deliver(event) : buffered.push(event)));
    subscriptions.set(id, live$);
    // An unsubscribe (or a closed connection) while the backlog is read ends the replay.
    const active = () => subscriptions.get(id) === live$;
    let head: number;
    try {
      head = await log.head(stream);
      for (;;) {
        const page = await log.read(stream, { after: lastSent, limit: BACKLOG_PAGE });
        if (!active()) break;
        for (const event of page) deliver(event);
        if (page.length < BACKLOG_PAGE) break;
      }
    } catch (error) {
      // A failed replay leaves nothing behind, so the client can retry with the same id.
      live$.dispose();
      if (active()) subscriptions.delete(id);
      throw error;
    }
    if (active()) {
      for (const event of buffered) deliver(event);
      live = true;
    }
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
