import {
  CONNECTIONS_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatTurnItemProps,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import { UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { lazyChunk } from "../../lib/lazy-chunk.tsx";

/**
 * `jhin.secrets-view`: an agent's request for a secret, answered privately
 * in its turn through the `chat.turn.item` slot (docs/plans/security.md,
 * D1032). Everything but this registration is a chunk of its own, so the
 * entry chunk stays small (D440).
 */
export const secretsViewPlugin = builtin(
  "jhin.secrets-view",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      context.subscriptions.add(
        context.services
          .get<SlotRegistry>(UI_SLOTS_CAPABILITY)
          .contribute<ChatTurnItemProps>("chat.turn.item", {
            id: "jhin.secrets.request",
            component: lazyChunk<ChatTurnItemProps>(
              () => import("./card.tsx").then((module) => module.secretRequestItem(context)),
              { loading: () => null, failed: () => null },
            ),
          }),
      );
    },
  }),
);
