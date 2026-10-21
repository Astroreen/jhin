import {
  CONNECTIONS_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatTurnItemProps,
  type Connections,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import { SecretsThreadEvents } from "@jhin/secrets-api";
import { UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { SecretRequestCard, type SecretRequestServices } from "./card.tsx";

/**
 * `jhin.secrets-view`: an agent's request for a secret, answered privately
 * in its turn through the `chat.turn.item` slot (docs/plans/security.md,
 * D1032).
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
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const services: SecretRequestServices = {
        connections: context.services.get<Connections>(CONNECTIONS_CAPABILITY),
        threads: context.services.get<ThreadsCatalog>(THREADS_CAPABILITY),
      };
      function SecretRequest(props: ChatTurnItemProps) {
        if (props.event.type !== SecretsThreadEvents.requestOpened) return null;
        return <SecretRequestCard {...props} services={services} />;
      }
      context.subscriptions.add(
        slots.contribute<ChatTurnItemProps>("chat.turn.item", {
          id: "jhin.secrets.request",
          component: SecretRequest,
        }),
      );
    },
  }),
);
