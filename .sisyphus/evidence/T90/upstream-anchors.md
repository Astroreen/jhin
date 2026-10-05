# T90 — upstream resizable-pane verification (t3code @ 37de6cb)

Checkout: /tmp/opencode/t3code, commit 37de6cbde65c7cf9ba90a2557c232e63b7e16988
("refactor(server): share one keyed lock that releases idle keys (#15577)").
Every number below was re-read from the checkout before coding (plan §17.3).

## Verified anchors

- Default width 256: `apps/web/src/components/threadSidebarWidth.ts:2`
  (`THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16`). Matches the plan's 256 and the
  client token `layout.sidebarWidth` (256).
- Min width 208: `threadSidebarWidth.ts:3` (`THREAD_SIDEBAR_MIN_WIDTH = 13 * 16`).
  Matches the plan's 208 and `layout.sidebarMinWidth`.
- Main-content min 640: `threadSidebarWidth.ts:4`
  (`THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16`). Matches the plan's `minSecond`
  640 and `layout.mainMinWidth`.
- Persistence key: `threadSidebarWidth.ts:1`
  (`chat_thread_sidebar_width`). Matches the plan.
- Persistence timing: written at drag end only, never per frame —
  `apps/web/src/hooks/useResizableWidth.ts:40-44` (doc comment "persisted on
  drag-end (not on every rAF tick)") and `:92-99` (`finish()` commits to
  localStorage); the sidebar rail's own `finish()` does the same
  (`apps/web/src/components/ui/sidebar.tsx:448-457`). Implemented as
  documented.
- Clamps: `sidebar.tsx:352-354` (`clampSidebarWidth` = max(min, min(w, max)))
  plus the main-min guard `shouldAcceptWidth` at
  `apps/web/src/components/AppSidebarLayout.tsx:318-323` (a wider divider is
  only accepted while the main content keeps >= 640) and the dynamic maximum
  `threadSidebarWidth.ts:11-16` (`resolveThreadSidebarMaximumWidth` =
  floor(viewport) - 640).
- Handle styling: the sidebar rail is an invisible 16 px-wide (`w-4`) button
  with a 2 px centre line revealed on hover (`hover:after:bg-sidebar-border`),
  `sidebar.tsx:472-485`; the right-panel handle is an 8 px-wide (`w-2`) hit
  area with a 1 px line that lights on hover/active (`role="separator"`,
  `aria-orientation="vertical"`, `cursor-col-resize`),
  `apps/web/src/components/preview/RightPanelResizeHandle.tsx:16-33`. Mapped
  to `handleStyle`: rail = 16 px hit + 2 px hover line, grip = 8 px hit +
  1 px always-visible line that brightens on hover, invisible = hit area only.
- Both upstream handles overlay the edge (the rail is `absolute`, the panel
  handle is `absolute -left-1`) — they consume no layout extent, so the
  Jhin client positions its handle in a Stack overlay too and the second
  pane is exactly `extent − width` (minSecond holds to the pixel).

## Plan-vs-upstream discrepancies found

1. Keyboard resize: the T90 plan (step 3) requires arrow-key resizing in
   16 px steps when the handle is focused; upstream has NO keyboard resize at
   all — the sidebar rail is `tabIndex={-1}` (`sidebar.tsx:520`) and the
   right-panel handle has no `onKeyDown` (`RightPanelResizeHandle.tsx` is
   pointer-only). Implemented per the plan (the spec wins), recorded here.
2. Maximum width: the plan has a static `max` prop; upstream computes the
   maximum dynamically as viewport − 640 (`threadSidebarWidth.ts:15`) and
   additionally refuses (does not animate) any growth that would push the
   main content below 640 (`AppSidebarLayout.tsx:318-323`). The Jhin client
   reproduces this with the `minSecond` clamp — the effective maximum is
   `min(maxProp, extent − minSecond)` — so the plan's static `max` prop
   stays optional and the upstream behaviour emerges from `minSecond`.
3. Mid-drag behaviour: upstream clamps live during the drag (the width never
   leaves `[min, max]`; `sidebar.tsx:406-413` + `useResizableWidth.ts:87-91`),
   so "snap back" is the divider holding at min, not an animated return. The
   Jhin client does the same (live clamp, animated only for non-drag changes
   over `motion.panel`), and the `--fail` QA asserts the held-at-min value.
4. The upstream rail also toggles the sidebar on click when the sidebar is
   not resizable (`sidebar.tsx:501-512`) — out of scope for the `split`
   primitive (collapse belongs to the T95/T96 shell/sidebar todos).
5. Upstream raises the min above 208 when the brand wordmark would clip
   (`threadSidebarWidth.ts:7-9`, `SidebarBrandWidthProbe`) — a screen-level
   concern, not a primitive prop; not ported.
