// The thread details panel follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ThreadDetailsCard.tsx (the card, its popover presentation) and
// PanelLayoutControls.tsx (the toggle); its Lineage section is lineage.tsx.
// docs/plans/t3-parity.md, D802.
import type {
  ChatHeaderActionProps,
  ChatThreadDetailsProps,
  Keybindings,
  Navigation,
  ThreadsCatalog,
} from "@jhin/client-api";
import { z, type PluginContext } from "@jhin/sdk";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
  ScrollArea,
  Slot,
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  type SlotRegistry,
} from "@jhin/ui";
import { SquareMenuIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useShortcutLabels } from "../../lib/hooks.ts";
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

  function ThreadDetailsToggle({ target, thread, project }: ChatHeaderActionProps) {
    const threadId = thread?.id;
    // The thread the panel is open for: another thread starts with it closed,
    // in the same render.
    const [openFor, setOpenFor] = useState<string | undefined>();
    // Leaving the thread closes it, so coming back finds it closed too.
    const [shown, setShown] = useState(threadId);
    if (shown !== threadId) {
      setShown(threadId);
      setOpenFor(undefined);
    }
    const open = openFor !== undefined && openFor === threadId;
    const setOpen = (next: boolean) => setOpenFor(next ? threadId : undefined);
    const shortcut = useShortcutLabels(keybindings)("chat.thread-details.toggle");
    useEffect(() => {
      if (threadId === undefined) return;
      const own = () => setOpenFor((current) => (current === threadId ? undefined : threadId));
      toggles.push(own);
      return () => {
        toggles.splice(toggles.indexOf(own), 1);
      };
    }, [threadId]);
    if (thread === undefined) return null;
    return (
      <Popover onOpenChange={setOpen} open={open}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Toggle
                    aria-label="Toggle thread details panel"
                    className="relative shrink-0"
                    pressed={open}
                    size="sm"
                    variant="ghost"
                  />
                }
              />
            }
          >
            <SquareMenuIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Toggle thread details{shortcut ? ` (${shortcut})` : ""}
          </TooltipPopup>
        </Tooltip>
        <PopoverPopup align="end" padding="none" side="bottom" variant="panel">
          <div
            aria-label="Thread details"
            className="dropdown-glass isolate grid max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))] w-80 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-3xl"
            role="region"
          >
            <ScrollArea className="min-h-0" scrollFade>
              <div className="peer empty:hidden">
                <Slot
                  name="chat.thread.details"
                  props={
                    {
                      target,
                      thread,
                      ...(project === undefined ? {} : { project }),
                    } satisfies ChatThreadDetailsProps
                  }
                />
              </div>
              <p className="hidden px-4 py-3 text-sm text-muted-foreground peer-empty:block">
                No details for this thread
              </p>
            </ScrollArea>
          </div>
        </PopoverPopup>
      </Popover>
    );
  }
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
    // A failed load shows nothing, as a thread without lineage does; opening the
    // panel again loads it again.
    // While it loads, a row's room: the panel does not say it has nothing meanwhile.
    { loading: () => <div aria-busy="true" className="h-12" />, failed: () => null },
  );
  context.subscriptions.add(
    slots.contribute<ChatThreadDetailsProps>("chat.thread.details", {
      id: "jhin.chat.lineage",
      order: 100,
      component: Lineage,
    }),
  );
}
