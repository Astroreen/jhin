import type { RpcClient } from "@jhin/rpc";

export interface StreamEvent {
  readonly stream: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Follows a stream of the node from its start: a subscription without `after`
 * gets every event after sequence 0, what the stream held before it too
 * ("replays the backlog" in packages/rpc/test/rpc.test.ts).
 * `until` resolves with the first event, seen or future, that matches: a test
 * waits for the record it expects, never for time. If the node refuses or ends
 * the subscription, every wait rejects, naming the stream and what it saw.
 */
export function follow(client: RpcClient, stream: string) {
  const events: StreamEvent[] = [];
  const waiters: {
    test: (event: StreamEvent) => boolean;
    resolve: (event: StreamEvent) => void;
    reject: (error: Error) => void;
  }[] = [];
  let failure: Error | undefined;
  const subscription = client.subscribe(
    stream,
    {
      onError(error) {
        const seen = events.map((event) => event.type).slice(-10);
        failure = new Error(
          `stream ${stream} ended (${error.message}) after ${events.length} events, last: ${seen.join(", ")}`,
        );
        for (const waiter of waiters.splice(0)) waiter.reject(failure);
      },
    },
    (event) => {
      events.push(event as StreamEvent);
      for (const waiter of waiters.filter((item) => item.test(event as StreamEvent))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event as StreamEvent);
      }
    },
  );
  return {
    events,
    until(test: (event: StreamEvent) => boolean): Promise<StreamEvent> {
      const seen = events.find(test);
      if (seen !== undefined) return Promise.resolve(seen);
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiters.push({ test, resolve, reject }));
    },
    close() {
      subscription.dispose();
      failure ??= new Error(`stream ${stream} closed after ${events.length} events`);
      for (const waiter of waiters.splice(0)) waiter.reject(failure);
    },
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- stream payloads are read field by field
export const payloadOf = (event: StreamEvent) => event.payload as Record<string, any>;
