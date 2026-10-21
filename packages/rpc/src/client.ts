import { toDisposable, type Disposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";

import type { Peer } from "./peer.ts";
import {
  ErrorCodes,
  RPC_ACK,
  RPC_EVENT,
  RPC_SUBSCRIBE,
  RPC_SUBSCRIPTION_ENDED,
  RPC_UNSUBSCRIBE,
  RpcError,
  type ErrorObject,
  type SubscriptionWindow,
} from "./protocol.ts";

export type ConnectionState = "connecting" | "open" | "closed";

export interface RpcClientOptions {
  /** Opens a new channel; rejects when it cannot (with `code: "UNAUTHENTICATED"` to stop retrying). */
  connect(): Promise<Peer>;
  /** Delay before the n-th reconnect attempt (n starts at 1). Default: 250ms doubling up to 10s. */
  retryDelay?(attempt: number): number;
  /**
   * Called with every new channel, before it is used: a two-way link serves
   * the other side's requests on it (`serveRpc(peer, …)`).
   */
  onConnected?(peer: Peer): void;
}

export interface ClientSubscription extends Disposable {
  /** Sequence of the last event delivered; a reconnect resumes after it. */
  readonly lastSequence: number;
}

export interface RpcClient {
  readonly state: ConnectionState;
  /** Why the client closed for good, when it did on its own (e.g. UNAUTHENTICATED). */
  readonly closeReason: RpcError | undefined;
  onState(listener: (state: ConnectionState) => void): Disposable;
  /** Calls a method; waits for the connection. Rejects with `DISCONNECTED` if it drops mid-call. */
  call<T = unknown>(method: string, params?: unknown, options?: { trace?: string }): Promise<T>;
  /**
   * Delivers every event of `stream` after `after`, exactly once and in order,
   * across reconnects.
   */
  subscribe(
    stream: string,
    options: {
      after?: number;
      /**
       * The node refused the subscription (other than a dropped connection),
       * or ended it (`SUBSCRIPTION_OVERFLOW`, D470); it is then disposed.
       */
      onError?: (error: RpcError) => void;
      /**
       * Flow control (D470): the node sends at most this much before the
       * client acknowledges it. Each event is acknowledged once `onEvent`
       * returns, or once the promise it returns settles.
       */
      window?: SubscriptionWindow;
    },
    onEvent: (event: StoredEvent) => void | Promise<void>,
  ): ClientSubscription;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: RpcError): void;
}

interface SubscriptionState {
  readonly stream: string;
  lastSequence: number;
  readonly onEvent: (event: StoredEvent) => void | Promise<void>;
  readonly onError: ((error: RpcError) => void) | undefined;
  readonly window: SubscriptionWindow | undefined;
  /**
   * Events of the current server subscription not acknowledged yet, in the
   * order they came: acknowledgements are cumulative on the node, so only
   * the settled ones at the front are acknowledged (D470).
   */
  handling: { sequence: number; done: boolean }[];
  /** Server-side id on the current connection. */
  serverId: string | undefined;
  disposed: boolean;
}

// Every runtime this package targets has timers, but lib "ESNext" does not declare them.
const timers = globalThis as unknown as { setTimeout(handler: () => void, ms: number): unknown };

const defaultDelay = (attempt: number) => Math.min(250 * 2 ** (attempt - 1), 10_000);

const closedError = (): RpcError =>
  new RpcError({
    code: ErrorCodes.DISCONNECTED,
    message: "Client closed before it could connect",
    data: { code: "DISCONNECTED" },
  });

const disconnected = (): RpcError =>
  new RpcError({
    code: ErrorCodes.DISCONNECTED,
    message: "Connection closed before the call completed",
    data: { code: "DISCONNECTED" },
  });

/** A client that reconnects on its own and resumes subscriptions where they stopped. */
export function createRpcClient(options: RpcClientOptions): RpcClient {
  const retryDelay = options.retryDelay ?? defaultDelay;
  let state: ConnectionState = "connecting";
  let closeReason: RpcError | undefined;
  let peer: Peer | undefined;
  let closedByUser = false;
  let nextId = 1;
  let nextSubscriptionId = 1;
  let attempt = 0;
  const pending = new Map<number, Pending>();
  const subscriptions = new Set<SubscriptionState>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let opened: { promise: Promise<Peer>; resolve(peer: Peer): void; reject(error: RpcError): void };

  const resetOpened = () => {
    let resolve!: (peer: Peer) => void;
    let reject!: (error: RpcError) => void;
    const promise = new Promise<Peer>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // A rejection nobody waits for (no call in flight) must not crash the process.
    promise.catch(() => undefined);
    opened = { promise, resolve, reject };
  };
  resetOpened();

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of Array.from(stateListeners)) listener(next);
  };

  function send(target: Peer, method: string, params: unknown, trace?: string): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // The connection may have dropped while the caller waited for it.
      if (peer !== target) {
        reject(disconnected());
        return;
      }
      pending.set(id, { resolve, reject });
      target.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
          ...(trace === undefined ? {} : { trace }),
        }),
      );
    });
  }

  async function startSubscription(target: Peer, subscription: SubscriptionState): Promise<void> {
    // The id is set before the call: backlog events arrive before its result.
    const id = String(nextSubscriptionId++);
    subscription.serverId = id;
    subscription.handling = [];
    try {
      await send(target, RPC_SUBSCRIBE, {
        subscription: id,
        stream: subscription.stream,
        after: subscription.lastSequence,
        ...(subscription.window === undefined ? {} : { window: subscription.window }),
      });
    } catch (error) {
      // A dropped connection is retried on reconnect; anything else is final.
      if (error instanceof RpcError && error.code === "DISCONNECTED") return;
      subscription.disposed = true;
      subscriptions.delete(subscription);
      subscription.onError?.(
        error instanceof RpcError
          ? error
          : new RpcError({
              code: ErrorCodes.SERVER_ERROR,
              message: String(error),
              data: { code: "INTERNAL" },
            }),
      );
      return;
    }
    if (subscription.disposed) {
      void send(target, RPC_UNSUBSCRIBE, { subscription: id }).catch(() => undefined);
    }
  }

  function onMessage(text: string): void {
    const message = JSON.parse(text) as {
      id?: number;
      result?: unknown;
      error?: ErrorObject;
      method?: string;
      params?: { subscription: string; event: StoredEvent; error?: ErrorObject };
    };
    if (message.method === RPC_EVENT && message.params !== undefined) {
      const { subscription: id, event } = message.params;
      for (const subscription of subscriptions) {
        if (subscription.serverId !== id || subscription.disposed) continue;
        const windowed = subscription.window !== undefined;
        const entry = { sequence: event.sequence, done: false };
        const target = peer;
        const handling = subscription.handling;
        if (windowed) handling.push(entry);
        /** Acknowledges the settled events at the front, in order. */
        const settle = () => {
          entry.done = true;
          let last: number | undefined;
          while (handling[0]?.done === true) last = handling.shift()!.sequence;
          // Only on the connection that sent it: a new one starts its own window.
          if (last === undefined || target === undefined || peer !== target) return;
          if (subscription.serverId !== id || subscription.handling !== handling) return;
          try {
            target.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: RPC_ACK,
                params: { subscription: id, sequence: last },
              }),
            );
          } catch {
            // Closed meanwhile: the next connection subscribes afresh.
          }
        };
        // Exactly once: a resumed subscription may resend the last event. The
        // node counts it as sent all the same, so it is acknowledged.
        if (event.sequence <= subscription.lastSequence) {
          if (windowed) settle();
          continue;
        }
        subscription.lastSequence = event.sequence;
        let handled: void | Promise<void>;
        try {
          handled = subscription.onEvent(event);
        } catch (error) {
          // A handler that throws still frees its place in the window.
          if (windowed) settle();
          throw error;
        }
        if (!windowed) continue;
        if (handled instanceof Promise) {
          void handled.then(settle, (error: unknown) => {
            settle();
            // Reported as a throwing handler would be.
            throw error;
          });
        } else settle();
      }
      return;
    }
    if (message.method === RPC_SUBSCRIPTION_ENDED && message.params !== undefined) {
      const { subscription: id, error } = message.params;
      for (const subscription of subscriptions) {
        if (subscription.serverId !== id || subscription.disposed) continue;
        subscription.disposed = true;
        subscriptions.delete(subscription);
        subscription.onError?.(
          new RpcError(
            error ?? {
              code: ErrorCodes.SERVER_ERROR,
              message: "Subscription ended",
              data: { code: "INTERNAL" },
            },
          ),
        );
      }
      return;
    }
    // A request from the other side of a two-way link: served by onConnected's handler.
    if (message.method !== undefined) return;
    if (typeof message.id !== "number") return;
    const call = pending.get(message.id);
    if (call === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) call.reject(new RpcError(message.error));
    else call.resolve(message.result);
  }

  async function open(): Promise<void> {
    setState("connecting");
    let next: Peer;
    try {
      next = await options.connect();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === "UNAUTHENTICATED") {
        closeReason = new RpcError({
          code: ErrorCodes.UNAUTHENTICATED,
          message: (error as Error).message,
          data: { code: "UNAUTHENTICATED" },
        });
        opened.reject(closeReason);
        setState("closed");
        return;
      }
      scheduleReconnect();
      return;
    }
    if (closedByUser) {
      next.close();
      return;
    }
    attempt = 0;
    peer = next;
    next.onMessage(onMessage);
    options.onConnected?.(next);
    next.onClose(() => {
      if (peer !== next) return;
      peer = undefined;
      for (const subscription of subscriptions) subscription.serverId = undefined;
      for (const call of pending.values()) call.reject(disconnected());
      pending.clear();
      if (closedByUser) {
        setState("closed");
        return;
      }
      resetOpened();
      scheduleReconnect();
    });
    await Promise.all(
      [...subscriptions].map((subscription) => startSubscription(next, subscription)),
    ).catch(() => undefined);
    if (peer !== next) return;
    setState("open");
    opened.resolve(next);
  }

  function scheduleReconnect(): void {
    if (closedByUser) return;
    setState("connecting");
    attempt += 1;
    timers.setTimeout(() => void open(), retryDelay(attempt));
  }

  void open();

  return {
    get state() {
      return state;
    },
    get closeReason() {
      return closeReason;
    },
    onState(listener) {
      stateListeners.add(listener);
      return toDisposable(() => stateListeners.delete(listener));
    },
    async call<T>(
      method: string,
      params?: unknown,
      callOptions: { trace?: string } = {},
    ): Promise<T> {
      if (closedByUser || closeReason !== undefined) throw closeReason ?? disconnected();
      const target = state === "open" && peer !== undefined ? peer : await opened.promise;
      return (await send(target, method, params ?? {}, callOptions.trace)) as T;
    },
    subscribe(stream, subscribeOptions, onEvent) {
      const subscription: SubscriptionState = {
        stream,
        lastSequence: subscribeOptions.after ?? 0,
        onEvent,
        onError: subscribeOptions.onError,
        window: subscribeOptions.window,
        handling: [],
        serverId: undefined,
        disposed: false,
      };
      subscriptions.add(subscription);
      // `peer` is set before `open()` snapshots the subscriptions to start, with no
      // await in between: if it is set, that snapshot did not include this one.
      if (peer !== undefined) void startSubscription(peer, subscription).catch(() => undefined);
      return {
        get lastSequence() {
          return subscription.lastSequence;
        },
        dispose() {
          if (subscription.disposed) return;
          subscription.disposed = true;
          subscriptions.delete(subscription);
          if (peer !== undefined && subscription.serverId !== undefined) {
            void send(peer, RPC_UNSUBSCRIBE, { subscription: subscription.serverId }).catch(
              () => undefined,
            );
          }
        },
      };
    },
    close() {
      if (closedByUser) return;
      closedByUser = true;
      if (peer === undefined) {
        // Nothing to close; calls waiting for a connection must not wait forever.
        opened.reject(closeReason ?? closedError());
        setState("closed");
      } else peer.close(1000, "client closed");
    },
  };
}
