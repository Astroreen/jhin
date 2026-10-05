# T98 upstream verification record

Upstream checkout: `/tmp/opencode/t3code`, commit `37de6cb`
(`refactor(server): share one keyed lock that releases idle keys (#15577)`).
Every quoted value below was re-read from that checkout before coding
(plan §17.3, risk 5).

## Verified anchors

### Menu items — `apps/web/src/components/threadActionMenu.logic.ts`

| Fact | Anchor |
| --- | --- |
| `Pin thread` / `Unpin thread`, icons `pin` / `pin-off`, conditional on `isPinned` under `supports.pinning` | `threadActionMenu.logic.ts:121-127` |
| `Settle thread` / `Un-settle thread`, icon `circle-check`, conditional on `isSettled` under `supports.settlement` | `threadActionMenu.logic.ts:131-137` |
| `Snooze` (icon `clock`, `disabled: !canSnoozeNow`) with children `${preset.label} (${preset.whenLabel})` + `Custom…` (`separatorBefore: true`); `Wake thread` (icon `clock`) while snoozed | `threadActionMenu.logic.ts:138-156` |
| `Regenerate title` (icon `refresh-cw`, `Regenerating…` while running) | `threadActionMenu.logic.ts:158-167` |
| `Auto-settle behavior` (icon `timer`) with checked `Enabled` / `Disabled` children | `threadActionMenu.logic.ts:184-204` |
| `Archive thread` (icon `archive`, `disabled: isRunning`, `separatorBefore: true`) | `threadActionMenu.logic.ts:224-230` |
| `Delete` (icon `trash`, `destructive: true`) | `threadActionMenu.logic.ts:231-236` |
| `Rename thread` (icon `pencil`, `separatorBefore: true`) | `threadActionMenu.logic.ts:157` |
| Dropped items with no Jhin backend: `new-thread-on-branch` (`:112-120`), `mark-unread` (`:168`), `filter-by-project` (`:169-179`), `Copy` submenu (`:205-217`), `project-settings` (`:218`) | — |

### Snooze presets — `packages/client-runtime/src/state/threadSettled.ts`

| Fact | Anchor |
| --- | --- |
| Preset ids `hour`, `three-hours`, `evening`, `tomorrow`, `next-week`; `{label, whenLabel, snoozedUntil}` | `threadSettled.ts:217-225` |
| `In 1 hour` / `In 3 hours` (fixed offsets, `whenLabel` = time of day) | `threadSettled.ts:258-274` |
| `This evening` (18:00 local) only while more than an hour away | `threadSettled.ts:276-285` (`EVENING_HOUR = 18` at `:213`) |
| `Tomorrow` (next day 09:00 local, `MORNING_HOUR = 9` at `:214`) | `threadSettled.ts:286-292` |
| `Next week` (Monday 09:00) unless it collapses onto the `Tomorrow` instant (a Sunday); `whenLabel` = short weekday + time | `threadSettled.ts:293-303` |
| Calendar-day advance, not fixed ms offsets (DST rule) | `threadSettled.ts:236-243` |

Ported to `SidebarBuilder.snoozePresets(long, ZoneId)` (system-default zone
at runtime, UTC in the JVM tests). The `whenLabel` clock format is
`h:mm a` (Locale.ROOT) — upstream uses the browser locale
(`toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})`,
`threadSettled.ts:227-229`); the fixed locale keeps the server-rendered
labels deterministic.

### Undo notice — `apps/web/src/hooks/showThreadUndoNotice.ts` + `components/sidebar/SidebarThreadUndoNotice.tsx`

| Fact | Anchor |
| --- | --- |
| Notice actions: `Settled` / `Snoozed` / `Unpinned` / `Archived` / `Discarded` | `showThreadUndoNotice.ts:12` |
| Notice text: `{action} {count} {noun},` with noun `thread`/`threads` (or `draft`/`drafts` for `Discarded`) | `SidebarThreadUndoNotice.tsx:15,20` |
| Inline `Undo` button (or `{shortcut} to undo` when the `thread.undo` keybinding exists) | `SidebarThreadUndoNotice.tsx:21-23` |
| 5 s undo window | `showThreadUndoNotice.ts:104-112` |
| Consecutive same-kind actions share one notice and restore together | `showThreadUndoNotice.ts:28-31,43-48` |
| Notice call sites: `Archived` (`useThreadActions.ts:384-385`), `Unpinned` (`:710-711`), `Settled` (`:763-764`), `Snoozed` (`:920-921`) — pinning, waking, unsetting and restoring show no notice | `useThreadActions.ts` (no `showThreadUndoNotice` call in `pinThread`, `unsettleThread`, `unsnoozeThread`) |

### Hover card — `apps/web/src/components/ThreadHoverCard.tsx` + `Sidebar.tsx`

| Fact | Anchor |
| --- | --- |
| Popup `side="right"`, `sideOffset={4}`, glass variant, `max-w-80` | `Sidebar.tsx:438`, `ThreadHoverCard.tsx:5-13` |
| Card shape: title line `text-xs leading-tight font-medium text-foreground truncate`, children `text-xs text-muted-foreground` | `ThreadHoverCard.tsx:26-31` |
| Trigger: the row's title span (the tooltip wraps the title + time span) | `Sidebar.tsx:2296-2317` |
| Metadata rows: project, environment, branch, provider, terminal, errors | `Sidebar.tsx:447-535` (Jhin carries the workdir row only) |

### Command subtitle — `apps/web/src/components/ThreadCommandSubtitle.tsx`

| Fact | Anchor |
| --- | --- |
| `text-xs text-muted-foreground/70` inline meta row with `·` dots | `ThreadCommandSubtitle.tsx:64-70,24-26` |
| Rendered by the command palette, not the sidebar rows | `CommandPalette.tsx` (the only importer) |

## Plan-vs-upstream discrepancies (resolved toward upstream)

1. **Undo wording.** The plan (T98 step 5) and the task brief quote
   `"Thread pinned"` / `"Thread snoozed"` as the upstream wording. The
   upstream files say otherwise: the notice reads `{action} {count} {noun},`
   — `Settled 1 thread,` / `Snoozed 1 thread,` / `Unpinned 1 thread,` /
   `Archived 1 thread,` (`showThreadUndoNotice.ts:12`,
   `SidebarThreadUndoNotice.tsx:15,20`) — and there is no `Pinned` action:
   pinning shows no notice at all (`useThreadActions.ts` `pinThread` has no
   `showThreadUndoNotice` call). The task marked
   `showThreadUndoNotice.ts` authoritative, so the implementation uses the
   upstream wording and the four upstream notice kinds; the pin action
   answers `refresh` only (the T73 journal still records the pin, so the
   undo works — the QA happy path proves it).
2. **Snooze presets.** The plan (T98 step 1) lists `1 hour / 24 hours /
   7 days / Custom…`. Upstream offers `In 1 hour`, `In 3 hours`, `This
   evening`, `Tomorrow`, `Next week` + `Custom…`
   (`threadSettled.ts:255-303`, `threadActionMenu.logic.ts:148-153`). The
   upstream preset list is implemented (with the collapse rules); the
   existing T76 snooze sheet (15 minutes / 1 hour / 4 hours / Tomorrow /
   Next week) stays as the action's no-duration fallback.
3. **Menu item set.** The plan's step-1 list omits Settle/Un-settle, but
   its step 2 dispatches `settle` and upstream carries the entries
   (`threadActionMenu.logic.ts:131-137`) — they are in the menu. Upstream
   items with no Jhin backend are dropped, not faked (branch, rename,
   mark-unread, project filter, copy, project settings); the upstream
   `rename` separator moves onto `Regenerate title` so the visual group
   boundary survives. Archive's `disabled: isRunning` (`:228`) is dropped —
   Jhin sessions carry no running flag. Snooze's `disabled: !canSnoozeNow`
   (`:146`) is dropped — the lifecycle service allows snoozing any open
   session.
4. **Notice coalescing count.** Upstream groups consecutive same-kind
   notices and shows the group count (`Settled 2 threads,`,
   `showThreadUndoNotice.ts:43-48`). The `UndoJournal` API (T73) exposes no
   entry inspection, so each Jhin notice reads `1 thread,`; the restore-side
   coalescing (oldest snapshot wins, one entry per session) is the T73
   journal semantics and stays green.
5. **ThreadCommandSubtitle placement.** The plan's T98 step 4 puts the
   command-subtitle marker on sidebar rows "when the row came from a
   palette search". Upstream renders `ThreadCommandSubtitle` in the command
   palette only (`CommandPalette.tsx` is the sole importer); sidebar rows
   never carry it. The `list_row` `commandSubtitle` prop is implemented
   client-side (widget-tested) and the sidebar emits no palette-sourced
   rows, so the marker never renders in the shipped sidebar tree.
6. **t97.sh gate assertion.** T98 moved the row title into the hover card,
   which invalidated T97's row-anatomy jq assertion (`.title.fontSize`).
   The gate script now unwraps the hover card (`.title.trigger.*`) — the
   T97 intent (semibold truncated title) is asserted under the T98 shape;
   the historical `evidence/T97/` outputs are untouched.
