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
/** Messages kept for a socket nobody listens on yet. */
const MAX_HELD_MESSAGES = 1000;

/**
 * A peer over a WebSocket. Messages that arrive while nobody listens are kept
 * and handed, in order, to the listeners present on the next tick: a link
 * whose handlers attach a moment after the socket opened loses nothing.
 */
export function webSocketPeer(socket: WebSocketLike): Peer {
  const listeners = new Set<(text: string) => void>();
  let held: string[] | undefined = [];
  let flushing = false;

  const deliver = (text: string) => {
    for (const listener of Array.from(listeners)) listener(text);
  };
  const flush = () => {
    flushing = false;
    const pending = held ?? [];
    held = listeners.size === 0 ? [] : undefined;
    for (const text of pending) deliver(text);
  };
  socket.addEventListener("message", (event: { data: unknown }) => {
    const text = String(event.data);
    if (held === undefined) {
      deliver(text);
      return;
    }
    held.push(text);
    // Nobody reads this socket: a peer that keeps sending must not grow memory forever.
    if (held.length > MAX_HELD_MESSAGES) {
      held = [];
      socket.close(1008, "too many unread messages");
    }
  });

  return {
    send(text) {
      if (socket.readyState === OPEN) socket.send(text);
    },
    close(code = 1000, reason = "") {
      socket.close(code, reason);
    },
    onMessage(listener) {
      listeners.add(listener);
      if (held !== undefined && !flushing) {
        flushing = true;
        void Promise.resolve().then(flush);
      }
      return toDisposable(() => {
        listeners.delete(listener);
        if (listeners.size === 0 && held === undefined) held = [];
      });
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
