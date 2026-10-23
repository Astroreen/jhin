// The mode switcher's buttons (D746), a chunk of its own (D440): a client
// with a single mode never loads it.
import type { Keybindings, Mode } from "@jhin/client-api";
import type { PluginContext } from "@jhin/sdk";
import { Badge, Tooltip, TooltipPopup, TooltipTrigger, cn } from "@jhin/ui";

import { useShortcutLabels } from "../lib/hooks.ts";
import { ModeIcon } from "../lib/use-modes.ts";

export function ModeButtons({
  badges,
  context,
  keybindings,
  list,
  current,
}: {
  badges: ReadonlyMap<string, number>;
  context: PluginContext;
  keybindings: Keybindings | undefined;
  list: readonly Mode[];
  current: Mode | undefined;
}) {
  const label = useShortcutLabels(keybindings)("ui.mode.next");
  // `ui.mode.next` goes to the mode after the current one only.
  const next = current === undefined ? undefined : list[(list.indexOf(current) + 1) % list.length];
  return (
    <div
      aria-label="Modes"
      className="flex shrink-0 items-center gap-1 border-t border-sidebar-border p-2"
      data-mode-switcher=""
      role="group"
    >
      {list.map((mode) => {
        const active = mode === current;
        // The mode being shown already shows what waits in it.
        const count = active ? 0 : (badges.get(mode.id) ?? 0);
        return (
          <Tooltip key={mode.id}>
            <TooltipTrigger
              render={
                <button
                  aria-label={count > 0 ? `${mode.title}, ${count} waiting` : undefined}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-hidden ring-ring focus-visible:ring-2",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  )}
                  data-mode={mode.id}
                  onClick={() =>
                    void context.commands
                      .execute("ui.mode.switch", { mode: mode.id })
                      .catch((error: unknown) =>
                        context.log.error("switching mode failed", {
                          mode: mode.id,
                          error: String(error),
                        }),
                      )
                  }
                  type="button"
                />
              }
            >
              <ModeIcon className="size-3.5 shrink-0" mode={mode} />
              <span className="truncate">{mode.title}</span>
              {count > 0 ? (
                <Badge aria-hidden size="sm" variant="warning">
                  {count}
                </Badge>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {mode.description ?? mode.title}
              {mode !== next || label === undefined ? "" : ` (${label})`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
