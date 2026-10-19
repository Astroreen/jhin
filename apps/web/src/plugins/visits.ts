import { VISITS_CAPABILITY } from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";
import { createVisits } from "../lib/thread-status.ts";

/** `client.visits@1`: when each thread was last looked at on this device. */
export const visitsPlugin = builtin(
  "jhin.visits",
  { provides: { [VISITS_CAPABILITY]: "1.0.0" } },
  definePlugin({
    activate(context) {
      const visits = context.subscriptions.add(createVisits());
      context.services.provide(VISITS_CAPABILITY, visits);
    },
  }),
);
