import type { Kernel } from "@jhin/kernel";

/** Resolves with the payload of the next `type` event: wait for facts, never for time. */
export function nextEvent(kernel: Pick<Kernel, "events">, type: string): Promise<unknown> {
  return new Promise((resolve) => {
    const subscription = kernel.events.on(type, (payload) => {
      subscription.dispose();
      resolve(payload);
    });
  });
}
