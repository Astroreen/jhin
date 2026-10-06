# T99 upstream verification record

Upstream checkout: `/tmp/opencode/t3code`, commit `37de6cb`
(`refactor(server): share one keyed lock that releases idle keys (#15577)`).
Every quoted value below was re-read from that checkout before coding
(plan §17.3, risk 5).

## Verified anchors

### Drop verbs — `apps/web/src/components/Sidebar.logic.ts`

| Fact | Anchor |
| --- | --- |
| `SidebarDropVerb = "pin" \| "unpin" \| "settle" \| "unsettle" \| "wake"` | `Sidebar.logic.ts:344` |
| `resolveSidebarDropVerb(from, to)`: `to === null \|\| to === from \|\| to === "working" \|\| to === "snoozed"` → `null`; `to === "pinned"` → `pin`; `to === "settled"` → `settle`; `from === "pinned"` → `unpin`; `from === "settled"` → `unsettle`; else `wake` | `Sidebar.logic.ts:346-357` |
| The Working and Snoozed shelves are never destinations (`resolveSidebarDropTarget` returns `null` for them) | `Sidebar.logic.ts:216-218` |

Ported to `SidebarBuilder.dropVerb(from, to)` + `dropTargetsOf(from)` (the
destination order Pinned / Active / Settled).

### Badge words and icons — `apps/web/src/components/Sidebar.tsx`

| Fact | Anchor |
| --- | --- |
| `dropVerbBadge`: `pin` → Pin (PinIcon), `unpin` → Unpin (PinOffIcon), `settle` → Settle (CircleCheckIcon), `unsettle` → Un-settle (Undo2Icon), `wake` → Wake (AlarmClockOffIcon) | `Sidebar.tsx:1041-1070` |
| Badge chip surface: `ml-auto inline-flex h-5 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary` | `Sidebar.tsx:1586-1592` |
| The badge replaces the hover actions during a drag ("Its status and hover actions hide during the drag") | `docs/user/thread-sidebar.md:79-81` |

Ported to the client chip (`list.dart` `_chipNode`: primary-tinted pill,
icon + word swapped per hovered target) and the server badge words
(`SidebarBuilder.badgeWord`).

### Boundary labels — `apps/web/src/components/Sidebar.tsx` + `index.css`

| Fact | Anchor |
| --- | --- |
| Zero-height markers `pinned-header` (label `Pinned`) and `pinned-divider` (label `Active`), `visible={from !== null}` — they exist only during a drag | `Sidebar.tsx:5261-5280`, `Sidebar.tsx:723-754` |
| Boundary anatomy: `text-xs font-medium` label + `h-px flex-1` line; drop target → `text-primary` / `bg-primary/50`, else `text-sidebar-foreground/80` / `bg-sidebar-foreground/25` | `Sidebar.tsx:736-752` |
| Reveal keyframe: `.sidebar-drag-boundary-label { animation: sidebar-drag-label-reveal 200ms step-end; }` — `visibility: hidden` → `visible` ("Let the sortable rows open label clearance before painting the dividers") | `index.css:2154-2165` |
| `SIDEBAR_DRAG_LABEL_HEIGHT = 24` (24 px opened per boundary during a drag) | `Sidebar.tsx:727` |
| Shelf headers keep their height while dragging; the settled header takes the `accent` tone while the lifted row is over it, `emphasized` while dragging | `Sidebar.tsx:758-792` |

Ported to the section spec `boundaryLabel` (Pinned/Active) and the client
boundary row (label + line, accent while hovered).

### Escape cancel — `apps/web/src/components/Sidebar.pointer.ts`

| Fact | Anchor |
| --- | --- |
| `keydown`: `if (event.code === "Escape") this.cancel();` | `Sidebar.pointer.ts:115` |
| Cancel restores the order visually; the drag itself never mutates | `Sidebar.pointer.ts:141-160` |

Ported to the client `HardwareKeyboard` handler installed only while a drag
is live (`list.dart` `_installEscape`).

### Mobile arrange sheet — `docs/user/thread-sidebar.md`

| Fact | Anchor |
| --- | --- |
| "On mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between **Pinned** and **Active** to reorder, pin, or unpin." | `thread-sidebar.md:85-86` |
| "Each drop saves; **Done** returns to the thread list." | `thread-sidebar.md:88` |

Ported to the `Arrange threads` menu entry opening the demo-marked `sheet`
(drag-handle rows of the Pinned+Active titles, `Done` → `dismissDialog`).

## Plan-vs-upstream discrepancies (resolved)

1. **Reveal duration.** The plan (T99 step 2) says "port of
   `@keyframes sidebar-drag-label-reveal`, `motion.panel` duration".
   Upstream runs a **fixed 200 ms step-end** (`index.css:2156`) — the
   `motion.panel` setting (`packages/contracts/src/settings.ts:107-116`,
   default 0, max 400) is a different mechanism and never appears in that
   keyframe. The implementation follows the plan: the reveal delay is the
   `motion.panel` token duration (default 0 ms → immediate reveal), with
   the step-end semantics preserved (nothing shows until the delay
   passes). Recorded here because the visual differs from upstream when
   the host keeps the default panel duration.
2. **Boundary labels vs always-on section headers.** Upstream's sidebar
   has no resting Pinned/Active headers — the boundary markers are the
   only labels and exist only during a drag. Jhin's sections always render
   uppercase headers (T96), so during a revealed drag the boundary
   anatomy (label + line) **replaces** the resting header instead of
   stacking a second label row above it. The drag-time visual matches
   upstream; the resting tree keeps the T96 headers.
3. **`dropTargets` shape.** The plan's `{id, label, accentWhenHovered}`
   cannot express the drop dispatch payload, so the entries carry an
   additive `action` (the standard action descriptor) — the client
   dispatches it exactly once and treats it as optional (a target without
   `action` is a purely decorative drop). Documented in `docs/sdui.md`
   §2.6.
4. **Badge icons.** The lucide `PinOff` has no Material counterpart; the
   badge uses `highlight_off` (the nearest negation glyph) — recorded in
   `icon-map.json`. The T98 overflow-menu entries keep their committed
   `keep` / `keep_off` names (the t98.sh gate asserts them verbatim);
   rewriting committed history is out of T99 scope.
5. **The chip follows the pointer.** Upstream keeps the dragged row
   stationary (`result[activeIndex] = stationary`,
   `Sidebar.drag.ts:249`) and paints the badge on it; no ghost follows the
   pointer. The plan (T99 step 2) says "a revealed label chip follows".
   The implementation does both: the in-place lifted row carries the chip
   (upstream parity) and the pointer-following feedback card carries it
   (the plan's wording). The widget tests assert `findsNWidgets(2)`.
6. **Working-shelf rows are not draggable.** Upstream's
   `resolveSidebarDropVerb` would answer `wake` for a working→active drop
   (the working shelf is a beta feature); Jhin keeps the Working shelf
   rows undraggable — the shelf is never a destination and its rows stay
   put.
7. **t98.sh gate assertion.** T99 added the `Arrange threads` menu entry,
   which invalidated T98's menu-item-set jq assertion (the label list and
   the Archive/Delete indices). The gate script now expects the eight-item
   set — the T98 intent (the upstream item set) is asserted under the T99
   shape; the historical `evidence/T98/` outputs are untouched (the same
   precedent as T98's t97.sh update, recorded in
   `evidence/T98/upstream-ref.md` discrepancy 6).
8. **"Arrange threads" placement.** The upstream checkout carries no
   desktop anchor for the entry (it is mobile-only UI; the docs name it at
   `thread-sidebar.md:85` without an order). It is placed after
   `Auto-settle behavior` and before the Archive separator; the sheet is
   emitted on every client (Jhin has no mobile detection), demo-marked.
9. **Pickup gesture.** Upstream activates a drag after 6 px of pointer
   travel in any direction (`SIDEBAR_DRAG_DISTANCE = 6`,
   `Sidebar.tsx:713-715`, the dnd-kit `SidebarPointerSensor`). A
   press-and-move recognizer on rows inside a vertical ListView would
   fight the scroll gesture arena, so the client picks rows up on a
   **long-press** (the Flutter `ReorderableListView` precedent) with
   `postAcceptSlopTolerance: null` — unlimited post-acceptance travel, the
   dnd-kit behaviour. Quick taps still navigate; the 6 px activation is
   not reproducible inside a scrollable without stealing the scroll.
