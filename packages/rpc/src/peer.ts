import { toDisposable, type Disposable } from "@jhin/sdk";

/** One end of a message channel: a WebSocket, an in-memory pipe, a stdio stream. */
export interface Peer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): Disposable;
  /** Fires once, after the channel closed for any reason. */
  onClose(listener: (info: { code: number; reason: string }) => void): Disposable;
}

/** The subset of the standard WebSocket API both browsers and Node (global WebSocket, ws) implement. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  removeEventListener(type: "message" | "close", listener: (event: never) => void): void;
}

const OPEN = 1;

export function webSocketPeer(socket: WebSocketLike): Peer {
  return {
    send(text) {
      if (socket.readyState === OPEN) socket.send(text);
    },
    close(code = 1000, reason = "") {
      socket.close(code, reason);
    },
    onMessage(listener) {
      const handler = (event: { data: unknown }) => listener(String(event.data));
      socket.addEventListener("message", handler);
      return toDisposable(() => socket.removeEventListener("message", handler as never));
    },
    onClose(listener) {
      const handler = (event: { code: number; reason: string }) =>
        listener({ code: event.code, reason: event.reason });
      socket.addEventListener("close", handler);
      return toDisposable(() => socket.removeEventListener("close", handler as never));
    },
  };
}

/**
 * Two connected in-memory peers. Messages arrive asynchronously, as over a real
 * socket. Closing either side closes both.
 */
export function createPeerPair(): [Peer, Peer] {
  type Side = {
    messages: Set<(text: string) => void>;
    closes: Set<(info: { code: number; reason: string }) => void>;
  };
  const sides: [Side, Side] = [
    { messages: new Set(), closes: new Set() },
    { messages: new Set(), closes: new Set() },
  ];
  let closed = false;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    void Promise.resolve().then(() => {
      for (const side of sides)
        for (const listener of Array.from(side.closes)) listener({ code, reason });
    });
  };
  const peer = (self: Side, other: Side): Peer => ({
    send(text) {
      if (closed) return;
      void Promise.resolve().then(() => {
        if (closed) return;
        for (const listener of Array.from(other.messages)) listener(text);
      });
    },
    close: (code = 1000, reason = "") => close(code, reason),
    onMessage(listener) {
      self.messages.add(listener);
      return toDisposable(() => self.messages.delete(listener));
    },
    onClose(listener) {
      self.closes.add(listener);
      return toDisposable(() => self.closes.delete(listener));
    },
  });
  return [peer(sides[0], sides[1]), peer(sides[1], sides[0])];
}
