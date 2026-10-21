// The header's toggle and the thread details panel it opens follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/components/chat/ThreadDetailsCard.tsx (the card,
// its popover presentation) and PanelLayoutControls.tsx (the toggle). A chunk of its own
// (D440), registered by thread-details.tsx. docs/plans/t3-parity.md, D802.
import type { ChatHeaderActionProps, ChatThreadDetailsProps, Keybindings } from "@jhin/client-api";
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
} from "@jhin/ui";
import { SquareMenuIcon } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import { useShortcutLabels } from "../../lib/hooks.ts";

/** The header's toggle, bound to the keybindings and the command's list of toggles. */
export function createThreadDetailsToggle(deps: {
  readonly keybindings: Keybindings | undefined;
  /** The toggles on screen, newest last, for `chat.thread-details.toggle`. */
  readonly toggles: (() => void)[];
}): ComponentType<ChatHeaderActionProps> {
  const { keybindings, toggles } = deps;
  return function ThreadDetailsToggle({ target, thread, project }: ChatHeaderActionProps) {
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
    // The Lineage chunk loads while the panel is still closed.
    useEffect(() => {
      void import("./lineage.tsx").catch(() => undefined);
    }, []);
    useEffect(() => {
      if (threadId === undefined) return;
      const own = () => setOpenFor((current) => (current === threadId ? undefined : threadId));
      toggles.push(own);
      return () => {
        const at = toggles.indexOf(own);
        if (at !== -1) toggles.splice(at, 1);
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
  };
}
