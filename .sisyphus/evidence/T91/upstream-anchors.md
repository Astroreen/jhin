# T91 — upstream hover_card / kbd / toast_stack verification (t3code @ 37de6cb)

Checkout: /tmp/opencode/t3code, commit 37de6cbde65c7cf9ba90a2557c232e63b7e16988
("refactor(server): share one keyed lock that releases idle keys (#15577)").
Every fact below was re-read from the checkout before coding (plan §17.3).

## Verified anchors

### hover_card

- There is no `components/ui/hover-card.tsx` upstream: the thread hover card
  is built on the tooltip primitive —
  `apps/web/src/components/ThreadHoverCard.tsx:5-13` (`ThreadHoverCardPopup`
  = `TooltipPopup` with `variant="glass"`, `max-w-80 text-left
  whitespace-normal`) and `:16-34` (the card body: truncated `text-xs`
  title, a `text-xs text-muted-foreground` metadata grid, optional footer).
- Placement: `apps/web/src/components/Sidebar.tsx:438` — `side="right"
  align="start" sideOffset={4}`. The contract's `placement` default is
  `top` (docs/sdui.md §2.6, fixed at T88); the 4 px gap is kept.
- Delay: the plan says "default 500 ms upstream". The upstream sidebar
  providers actually run `delay={150} closeDelay={0} timeout={400}`
  (`Sidebar.tsx:4996` and `:5062`); 500 ms is the plan's chosen contract
  default (the Base UI global default could not be verified — node_modules
  are absent from the checkout). Implemented per the contract: default 500,
  the `delay` prop overrides.
- Touch: Base UI tooltips open on long-press on touch devices; implemented
  as a long-press toggle (the hold is the touch equivalent of the hover
  delay).
- Nesting: upstream cards are portal-based and stack by insert order; the
  client mirrors that with one overlay entry per open card, later entries
  above earlier ones.

### kbd

- Pill look: `apps/web/src/components/ui/kbd.tsx:5-26` — `h-5 min-w-5
  rounded bg-muted px-1 font-medium font-sans text-xs text-muted-foreground`,
  the group `inline-flex gap-1` (`KbdGroup`, `:18-26`).
- Token mapping: the plan's `--control-radius` is `0.5rem`
  (`apps/web/src/index.css:101`) ≡ the §4.3 `radius.md` token
  (`calc(0.625rem - 2px)` = 8 px); the plan's `text-2xs` is `0.6875rem`
  (`index.css:178-179`) ≡ the §4.3 `text.xs2` token (11 px). Both resolved
  through the token surface, not literals.
- Modifier labels: `apps/web/src/lib/snapShotShortcut.ts:62-77` — shift is
  ⇧ everywhere; on the Apple platforms ctrl/alt/meta are ⌃/⌥/⌘; off them
  ctrl/alt are the texts `Ctrl`/`Alt` and meta is ⊞ on Windows, `Super`
  elsewhere.
- `mod` resolution: `apps/web/src/keybindings.ts:271-277` —
  `useMetaForMod = isMacPlatform(platform)`; mod is meta on the Apple
  platforms, ctrl elsewhere, and it collapses with an explicit ctrl
  (`showCtrl = ctrlKey || (modKey && !useMetaForMod)` is a boolean).
- Modifier order: `snapShotShortcut.ts:66-77` — control, alt, shift, meta,
  then the key.
- Key labels: `apps/web/src/keybindings.ts:255-265` — `Space`, uppercased
  single chars, `Esc`, the arrow abbreviations, anything else capitalized;
  the accepted key-name set follows the regex in
  `lib/snapShotShortcut.ts:68-71` (f1-f24, enter, tab, escape, backspace,
  delete, insert, home, end, pageup, pagedown, arrow*) plus the desktop
  aliases at `:14-23` (`return` → `enter`).
- Platform detection: upstream reads `navigator.platform`
  (`lib/utils.ts:15-17`, `/mac|iphone|ipad|ipod/i`); the client maps the
  theme's `TargetPlatform` (macOS/iOS → the Apple labels, windows → ⊞,
  everything else → Ctrl/Super) — the testable seam.

### toast_stack

- Undo window: `apps/web/src/hooks/showThreadUndoNotice.ts:104-112` — the
  notice expires after `5_000` ms; consecutive same-kind actions share one
  notice (`:28-48`). The contract item default `duration: 5000` matches.
- Notice look: `apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx:17-26`
  — an `Alert variant="sidebar"` with `{action} {count} {noun},` plus an
  `InlineButton` labelled `Undo` (or the bound shortcut). The client's item
  with an inline action renders the notice text, an `Undo` text button and
  the close control.
- Toast card: `apps/web/src/components/ui/toast.tsx:520` (default position
  `top-right` — the contract's `direction` default is `bottom`, fixed at
  T88), `:551` (`max-w-90` = 360 px), `:568` (the frontmost-newest stack —
  the newest item sits at the screen edge), `:97-102` (the corner dismiss
  orb: a 24 px circular button with the X icon) and `:76-82` (the per-type
  icons: error/success/info/warning/loading).
- The upstream stack is Base UI's toast manager (not sonner); the client
  ports the geometry (360 px cap, edge-aligned column, newest at the edge,
  per-item window) onto a plain overlay column — no new dependencies
  (§14.2).

## Discrepancies vs the plan

1. Plan step 1 says hover_card delay "default 500 ms upstream" — the
   upstream sidebar hover cards run 150 ms (`Sidebar.tsx:4996,5062`); 500 ms
   is the contract default chosen at T88 (docs/sdui.md §2.6) and kept.
2. Upstream has no `components/ui/hover-card.tsx` — the card rides the
   tooltip primitive with `variant="glass"`; the client renders a flat
   popover card (the contract defines no `glass` prop on `hover_card`).
3. Upstream thread hover cards place `side="right"`; the contract default
   placement is `top` (T88 wording, kept).
4. Upstream toasts default to `top-right`; the contract's `direction` is
   `top|bottom` with default `bottom` (T88 wording, kept).
5. The numbered wire goldens (30/31/32) are emitted by `UiRegressionTest`
   (the T55 capture harness that owns `plugins/ui-kit/src/test/resources/
   regression/00..29`), not by `GalleryDump` — `GalleryDump` emits the
   level-2 gallery fixture file and its `EXPECTED_PRIMITIVES` assertion
   pins the 58-primitive level-2 set, so the level-3 nodes follow the T90
   precedent (`29-split.json`).
