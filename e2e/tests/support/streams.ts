import type { RpcClient } from "@jhin/rpc";

export interface StreamEvent {
  readonly stream: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Follows a stream of the node from its start. `until` resolves with the first
 * event, seen or future, that matches: a test waits for the record it expects,
 * never for time.
 */
export function follow(client: RpcClient, stream: string) {
  const events: StreamEvent[] = [];
  const waiters: { test: (event: StreamEvent) => boolean; resolve: (e: StreamEvent) => void }[] =
    [];
  const subscription = client.subscribe(stream, {}, (event) => {
    events.push(event as StreamEvent);
    for (const waiter of waiters.filter((item) => item.test(event as StreamEvent))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event as StreamEvent);
    }
  });
  return {
    events,
    until(test: (event: StreamEvent) => boolean): Promise<StreamEvent> {
      const seen = events.find(test);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ test, resolve }));
    },
    close: () => subscription.dispose(),
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- stream payloads are read field by field
export const payloadOf = (event: StreamEvent) => event.payload as Record<string, any>;
