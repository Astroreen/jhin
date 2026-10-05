# T97 decisions — plan vs upstream (t3code commit 37de6cb)

Every quoted value was re-read from the upstream checkout before coding
(plan §17 handoff point 3, risk 5). Where the plan's literal value and the
upstream source disagree, the plan wins (the todo is the contract) and the
upstream anchor is recorded here.

## 1. Search input placeholder

- Plan T97 step 1: placeholder **"Search threads"**.
- Upstream: `placeholder="Search"` with `aria-label="Search threads"`
  (`apps/web/src/components/sidebar/SidebarThreadHeader.tsx:73-74`).
- Resolution: emitted `placeholder: "Search threads"` (plan-literal; the
  plan's string matches the upstream aria-label, not the placeholder).

## 2. New thread control

- Plan T97 step 1: a **primary button "New thread"**.
- Upstream: an icon button (`SquarePenIcon`, `size-7`) with the
  `New thread` tooltip and the Shift+click hint
  (`SidebarThreadHeader.tsx:63, 117-127`).
- Resolution: emitted the primary `button` labelled `New thread` with the
  `add` icon (plan-literal). The button opens the new-thread form dialog
  whose submit dispatches the real `create-session` action (the include
  values ride the UiState ids, so they survive the dialog overlay — the
  ActionDispatcher reads `state[id]` even when the field node is not under
  the screen root).

## 3. Sidebar header wordmark

- Plan T97 step 1: the header block carries a **wordmark** (T3Wordmark-style
  bold text).
- Upstream: the brand lives in the titlebar row (`SidebarBrandMark`,
  `apps/web/src/components/sidebar/SidebarChrome.tsx:125-140`); the sidebar
  header row holds search + project scope + new thread only
  (`SidebarThreadHeader.tsx:31-36`).
- Resolution: emitted the bold `Jhin` text in the sidebar header
  (plan-literal; the shell topbar already carries the same wordmark from
  T95).

## 4. Collapsed-state chevron

- Plan T97 step 1: a collapsed-state chevron button in the header.
- Upstream: `SidebarTrigger` toggles the sidebar
  (`SidebarChrome.tsx:47-52`).
- Resolution: emitted the `chevron_right` icon button **demo-marked** — the
  T96 split has no collapse mechanism, so the affordance is decorative
  (§14.10: interactive without a real effect ⇒ `demo: true`).

## 5. Footer composition

- Plan T97 step 1b: ConnectionStatusDot + account chip + Settings +
  profile switching.
- Upstream: the sidebar footer is the undo notice + provider update pill +
  architecture warning + the utility menu (Settings / Pull Requests / Usage
  + update pill, `SidebarChrome.tsx:224-248`); the ConnectionStatusDot is
  used in the cloud/settings surfaces, not the sidebar footer
  (`components/ConnectionStatusDot.tsx:12-24`); the account avatar chip
  lives in the settings sidebar footer
  (`components/settings/SettingsSidebarNav.tsx:352-366`).
- Resolution: emitted the plan's footer (Online dot + account chip +
  Settings + openProfiles). The dot states the server-reachable phase only —
  offline rendering is a client concern this todo does not wire (recorded
  for a later todo).

## 6. Status indicator set and tooltips

- Plan T97 step 3: ten kinds — working (spinner, pulse), idle (circle 12px),
  monitoring (eye), needs-approval / needs-answer (alert-circle), failed
  (alert-triangle), limited (zap), snoozed (pause), settled (check-circle),
  unread (filled 6px dot, ping), pinned (lock) — with the tooltips
  "Working", "Needs approval", "Needs answer", "Failed", "Limited",
  "Snoozed", "Settled", "Unread", "Pinned".
- Upstream: the status model is `SidebarThreadStatus` = approval | input |
  working | waiting | failed | limited | ready
  (`components/Sidebar.logic.ts:944-952`); the status pill labels are
  "Pending Approval", "Awaiting Input", "Working", "Connecting", "Waiting",
  "Plan Ready", "Completed" (`Sidebar.logic.ts:1160-1231`); the row top
  status labels are "Working", "Waiting", "Approval", "Input", "Limited",
  "Failed", "Woke", "Done" (`components/Sidebar.tsx:1296-1311`). The strings
  "Needs approval" / "Needs answer" do not exist upstream (rg over
  apps/packages/docs finds them only in prose docs and test fixtures).
- Resolution: implemented the plan's ten-kind set with the plan's tooltip
  strings (the Jhin session model is the plan's own adaptation: the sessions
  plugin carries free-form statuses plus the pinned/settled/snoozed
  lifecycle). `idle` renders with no tooltip (upstream renders no pill for
  the unlabeled resting state, `Sidebar.logic.ts:940-943`); `monitoring`
  renders the tooltip "Monitoring" (no upstream anchor — the plan lists no
  label for it either).

## 7. Row title weight

- Plan T97 step 2: title `text-sm font-semibold truncate`.
- Upstream: `text-sm font-medium truncate` (font-normal while receding)
  (`components/Sidebar.tsx:1620-1624`).
- Resolution: emitted fontSize 14 / fontWeight 600 (plan-literal).

## 8. Search surface shape

- Plan T97 step 1c: the search filters rows client-side, non-matching rows
  collapse out via setState, a match-count line appears above the sections,
  2+ characters highlight matches as ThreadSearchMatch pills.
- Upstream: searching replaces the section list with a flat results listbox
  ("Thread search results") or the "No threads found" status line
  (`components/Sidebar.tsx:4994-5046`); there is no match-count line.
- Resolution: implemented the plan's filter (the `list.search` spec) and
  kept the upstream "No threads found" text for the zero-matches case. The
  plan's "Find work" phrase has no upstream anchor (rg finds nothing); it is
  preserved as the match-count line's semantics label.

## 9. ThreadContextChip repurposed

- Plan T97 step 2: the subtitle carries a ThreadContextChip pill
  `px-1.5 py-0.5 text-xs` with tooltip `Project: …`/`Branch: …`.
- Upstream: `ThreadContextChip` is the attached-thread chip (MessagesSquare
  icon + live title, tooltip "Open thread",
  `components/ThreadContextChip.tsx:12-38`); the base ContextChip metrics
  are em-based (`components/ContextChip.tsx:24-27`).
- Resolution: emitted the plan's pill as a bordered `box` (padding 6/2,
  fontSize 12) with the `Project: <workdir>` tooltip. Jhin sessions carry no
  branch field, so only the Project chip exists (no Branch chip — no data).

## 10. Unread kind

- The sessions plugin's `Session` record carries no unseen/last-visited
  field, so the server never emits the `unread` kind yet; the client widget
  supports it (the 6 px ping dot) and the T92 unread semantics hold.

## 11. Pre-existing repository quirk (not introduced by this todo)

- `plugins/ui-default/build.gradle` and `kernel/build.gradle` reference
  `org.xerial:sqlite-jdbc:3.50.1.0` (committed before
  this todo); the version resolves from the pre-populated Gradle cache and
  every suite is green. Left untouched — out of T97 scope, reported here.
