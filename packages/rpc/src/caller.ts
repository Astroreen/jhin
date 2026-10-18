import type { Disposable } from "@jhin/sdk";

import type { Peer } from "./peer.ts";
import { ErrorCodes, RpcError, type ErrorObject } from "./protocol.ts";

export interface Caller extends Disposable {
  call<T = unknown>(method: string, params?: unknown, options?: { trace?: string }): Promise<T>;
}

/**
 * Calls the other side of a channel this side did not open: the server end of
 * a two-way link. Request ids are strings, so they never collide with the
 * numeric ids of a client on the same channel.
 */
export function createCaller(peer: Peer): Caller {
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: RpcError): void }
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
      result?: unknown;
      error?: ErrorObject;
    };
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
  };
  const closes = peer.onClose(close);

  return {
    call<T>(method: string, params?: unknown, options: { trace?: string } = {}): Promise<T> {
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
    },
    dispose() {
      messages.dispose();
      closes.dispose();
      close();
    },
  };
}
