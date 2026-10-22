import { THREADS_CAPABILITY, VISITS_CAPABILITY, type ThreadsCatalog } from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";
import { createVisits } from "../lib/thread-status.ts";

/**
 * `client.visits@1`: when each thread was last looked at, on this device and,
 * through the thread's node, on every device (D485).
 */
export const visitsPlugin = builtin(
  "jhin.visits",
  { provides: { [VISITS_CAPABILITY]: "1.0.0" }, optional: { [THREADS_CAPABILITY]: "^1" } },
  definePlugin({
    activate(context) {
      const threads = context.services.tryGet<ThreadsCatalog>(THREADS_CAPABILITY);
      const visits = context.subscriptions.add(
        createVisits(
          localStorage,
          threads === undefined
            ? undefined
            : {
                record: (target, threadId) =>
                  threads.catalog(target).threads.find((thread) => thread.id === threadId),
                call: (target, method, params) => threads.call(target, method, params),
              },
        ),
      );
      context.services.provide(VISITS_CAPABILITY, visits);
    },
  }),
);
