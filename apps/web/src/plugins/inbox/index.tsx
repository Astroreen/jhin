// The owner's inbox in Civilization mode (docs/plans/agents.md, A2: D626,
// D630): open items in `civilization.sidebar.inbox`, an item's page in
// `civilization.views`, and a notification when an agent asks the owner.
import type { InboxItem } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  MODES_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Modes,
  type Navigation,
  type NodeConnection,
} from "@jhin/client-api";
import { definePlugin, z } from "@jhin/sdk";
import {
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { MessageCircleQuestionIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { CIVILIZATION_MODE } from "../../lib/modes.ts";
import { useExternal } from "../../lib/hooks.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { tellOwner } from "../../lib/tell-owner.tsx";
import { INBOX_PANEL, inboxRoute, senderLabel } from "./route.ts";
import { createInboxStore, openCount } from "./store.ts";
import type { InboxView } from "./views.tsx";

// The views are a chunk of their own (D440), loaded once Civilization mode shows them.
const viewsChunk = () => import("./views.tsx");
const List = lazyChunk(() => viewsChunk().then((module) => module.InboxList), {
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load the inbox.</ChunkFailed>
  ),
});
const Page = lazyChunk(() => viewsChunk().then((module) => module.InboxPage), {
  loading: () => null,
  failed: (_props: object, retry: () => void) => (
    <ChunkFailed retry={retry}>Couldn't load this message.</ChunkFailed>
  ),
});

/**
 * `jhin.inbox`: what agents sent and asked the owner, on every connected node
 * (D626, D630). It shows in Civilization mode only (D741); the notification
 * of a new item shows in any mode and opens Civilization mode's inbox.
 */
export const inboxPlugin = builtin(
  "jhin.inbox",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1", [MODES_CAPABILITY]: "^1.1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);

      const open = (node: string, messageId: string) =>
        navigation.navigate(inboxRoute(node, messageId));
      /** A new item: a toast while the page has focus, else a system notification (D630). */
      const arrived = (connection: NodeConnection, item: InboxItem) => {
        const { message } = item;
        const told = tellOwner(context.config, toasts, {
          title:
            message.kind === "ask"
              ? `${senderLabel(message.from)} asks you`
              : `${senderLabel(message.from)} wrote to you`,
          body: message.body.trim().split("\n")[0] ?? "",
          tag: message.messageId,
          icon: <MessageCircleQuestionIcon className="size-4" />,
          actionLabel: "Open inbox",
          open: () => open(connection.id, message.messageId),
        });
        // Not lost: it is in the sidebar; the log says it was not told.
        if (!told) context.log.info("an inbox item was not told", { messageId: message.messageId });
      };
      const store = createInboxStore(connections, context.log, arrived);
      context.subscriptions.add(store);
      // The open items on Civilization mode's button in the switcher (D1273).
      const badge = context.services.tryGet<Modes>(MODES_CAPABILITY)?.badge(CIVILIZATION_MODE);
      if (badge !== undefined) {
        context.subscriptions.add(badge);
        const count = () => badge.set(openCount(store.snapshot()));
        context.subscriptions.add(store.subscribe(count));
        count();
      }
      const view: InboxView = { store, connections, navigation, toasts };

      // Opening an item is a command, so the palette, CLI and MCP reach it (rule 6).
      context.subscriptions.add(
        context.commands.register({
          name: "civilization.inbox.open",
          title: "Open inbox item",
          description: "Opens a message or ask to the owner in Civilization mode's inbox (D630)",
          input: z.object({
            node: z.string().min(1).meta({ description: "The connection the item is on" }),
            messageId: z.string().min(1),
          }),
          output: z.object({}),
          handler: ({ node, messageId }) => {
            open(node, messageId);
            return {};
          },
        }),
      );

      const InboxList = () => <List view={view} />;
      const InboxItemView = () => {
        const route = useExternal(navigation, navigation.current);
        // Only its own panel: the other views of `civilization.views` render theirs (D750).
        if (route.panel !== INBOX_PANEL || route.node === undefined) return null;
        if (route.section === undefined) return null;
        return (
          <Page
            key={`${route.node}|${route.section}`}
            messageId={route.section}
            node={route.node}
            view={view}
          />
        );
      };
      context.subscriptions.add(
        slots.contribute("civilization.sidebar.inbox", {
          id: "jhin.inbox.list",
          component: InboxList,
        }),
      );
      context.subscriptions.add(
        slots.contribute("civilization.views", { id: "jhin.inbox.item", component: InboxItemView }),
      );
    },
  }),
);
