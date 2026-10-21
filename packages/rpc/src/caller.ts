import { toDisposable, type Disposable } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";

import type { Peer } from "./peer.ts";
import {
  ErrorCodes,
  RPC_SUBSCRIPTION_ENDED,
  RPC_EVENT,
  RPC_SUBSCRIBE,
  RPC_UNSUBSCRIBE,
  RpcError,
  type ErrorObject,
} from "./protocol.ts";

export interface Caller extends Disposable {
  call<T = unknown>(method: string, params?: unknown, options?: { trace?: string }): Promise<T>;
  /**
   * Subscribes to a stream of the other side, delivering events after `after`
   * in order and once. Ends when the channel closes (no reconnect here).
   * `onReady` gets the head once the other side accepted it; `onError` why it
   * refused, or ended it later (`rpc.subscription.ended`).
   */
  subscribe(
    stream: string,
    after: number,
    onEvent: (event: StoredEvent) => void,
    outcome?: { onReady?(head: number): void; onError?(error: RpcError): void },
  ): Disposable;
}

/**
 * Calls the other side of a channel this side did not open: the server end of
 * a two-way link. Request and subscription ids are strings, so they never
 * collide with the numeric ids of a client on the same channel.
 */
export function createCaller(peer: Peer): Caller {
  let nextId = 1;
  let nextSubscription = 1;
  let closed = false;
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: RpcError): void }
  >();
  const subscriptions = new Map<
    string,
    {
      last: number;
      onEvent: (event: StoredEvent) => void;
      onError: ((error: RpcError) => void) | undefined;
    }
  >();
  const gone = () =>
    new RpcError({
      code: ErrorCodes.DISCONNECTED,
      message: "Connection closed before the call completed",
      data: { code: "DISCONNECTED" },
    });

  const messages = peer.onMessage((text) => {
    const message = JSON.parse(text) as {
      id?: unknown;
      method?: unknown;
      params?: { subscription?: string; event?: StoredEvent; error?: ErrorObject };
      result?: unknown;
      error?: ErrorObject;
    };
    if (message.method === RPC_SUBSCRIPTION_ENDED && message.id === undefined) {
      const id = message.params?.subscription ?? "";
      const target = subscriptions.get(id);
      if (target === undefined) return;
      subscriptions.delete(id);
      target.onError?.(
        new RpcError(
          message.params?.error ?? {
            code: ErrorCodes.SERVER_ERROR,
            message: "Subscription ended",
            data: { code: "INTERNAL" },
          },
        ),
      );
      return;
    }
    if (message.method === RPC_EVENT && message.id === undefined) {
      const target = subscriptions.get(message.params?.subscription ?? "");
      const event = message.params?.event;
      if (target === undefined || event === undefined || event.sequence <= target.last) return;
      target.last = event.sequence;
      target.onEvent(event);
      return;
    }
    if (message.method !== undefined || typeof message.id !== "string") return;
    const call = pending.get(message.id);
    if (call === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) call.reject(new RpcError(message.error));
    else call.resolve(message.result);
  });
  const close = () => {
    closed = true;
    for (const call of pending.values()) call.reject(gone());
    pending.clear();
    subscriptions.clear();
  };
  const closes = peer.onClose(close);

  const call = <T>(
    method: string,
    params?: unknown,
    options: { trace?: string } = {},
  ): Promise<T> => {
    if (closed) return Promise.reject(gone());
    const id = `c${nextId++}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      peer.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: params ?? {},
          ...(options.trace === undefined ? {} : { trace: options.trace }),
        }),
      );
    });
  };

  return {
    call,
    subscribe(stream, after, onEvent, outcome = {}) {
      const id = `s${nextSubscription++}`;
      subscriptions.set(id, { last: after, onEvent, onError: outcome.onError?.bind(outcome) });
      void call<{ head?: unknown }>(RPC_SUBSCRIBE, { subscription: id, stream, after }).then(
        (result) => {
          if (!subscriptions.has(id)) return;
          outcome.onReady?.(typeof result?.head === "number" ? result.head : 0);
        },
        (error: RpcError) => {
          if (!subscriptions.delete(id)) return;
          outcome.onError?.(error);
        },
      );
      return toDisposable(() => {
        if (!subscriptions.delete(id) || closed) return;
        void call(RPC_UNSUBSCRIBE, { subscription: id }).catch(() => undefined);
      });
    },
    dispose() {
      messages.dispose();
      closes.dispose();
      close();
    },
  };
}
