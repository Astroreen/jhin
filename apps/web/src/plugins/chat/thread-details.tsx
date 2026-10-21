// The thread details panel (D802): its command, keybinding and contributions. The
// toggle and panel are thread-details-panel.tsx and the Lineage section lineage.tsx,
// each a chunk of its own (D440). docs/plans/t3-parity.md, D802.
import type {
  ChatHeaderActionProps,
  ChatThreadDetailsProps,
  Keybindings,
  Navigation,
  ThreadsCatalog,
} from "@jhin/client-api";
import { z, type PluginContext } from "@jhin/sdk";
import type { SlotRegistry } from "@jhin/ui";

import { lazyChunk } from "../../lib/lazy-chunk.tsx";

/**
 * The header's toggle, the panel it opens, `chat.thread-details.toggle` and
 * the Lineage section (D802).
 */
export function registerThreadDetails(
  context: PluginContext,
  services: {
    readonly threads: ThreadsCatalog;
    readonly navigation: Navigation;
    readonly slots: SlotRegistry;
    readonly keybindings: Keybindings | undefined;
  },
) {
  const { threads, navigation, slots, keybindings } = services;
  /** The toggles on screen, newest last: the command works the newest (one, in Jhin's one thread view). */
  const toggles: (() => void)[] = [];

  context.commands.register({
    name: "chat.thread-details.toggle",
    title: "Toggle thread details",
    description:
      "Opens or closes the open thread's details panel (its lineage and what plugins add)",
    input: z.object({}),
    /** `toggled`: false when no thread is open, so there was no panel to toggle. */
    output: z.object({ toggled: z.boolean() }),
    handler: () => {
      const toggle = toggles.at(-1);
      toggle?.();
      return { toggled: toggle !== undefined };
    },
  });
  if (keybindings !== undefined) {
    context.subscriptions.add(
      keybindings.addDefaults([
        { key: "mod+shift+b", command: "chat.thread-details.toggle", when: "!terminalFocus" },
      ]),
    );
  }

  // The toggle and its panel are a chunk of their own (D440), loaded with the header.
  const ThreadDetailsToggle = lazyChunk(
    () =>
      import("./thread-details-panel.tsx").then((module) =>
        module.createThreadDetailsToggle({ keybindings, toggles }),
      ),
    { loading: () => null, failed: () => null },
  );
  context.subscriptions.add(
    slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
      id: "jhin.chat.thread-details",
      order: -20,
      component: ThreadDetailsToggle,
    }),
  );

  // Its rows load with the panel, a chunk of their own (D440).
  const Lineage = lazyChunk(
    () =>
      import("./lineage.tsx").then((module) =>
        module.createLineage({ threads, navigation, commands: context.commands }),
      ),
    {
      // Loaded ahead, once the header's toggle shows (below): opening the panel
      // rarely waits for it.
      loading: () => null,
      // Shows nothing, as a thread without lineage does; the panel opened again loads it again.
      failed: () => null,
    },
  );
  context.subscriptions.add(
    slots.contribute<ChatThreadDetailsProps>("chat.thread.details", {
      id: "jhin.chat.lineage",
      order: 100,
      component: Lineage,
    }),
  );
}
