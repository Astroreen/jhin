# T3 Code parity plan

Status: **implemented**. This file records the decisions taken while
bringing T3 Code's design and features into Jhin's plugin system, what was
left out on purpose, and what is deferred.

## Goal

Make the web client look and behave like T3 Code, and give the agent API what
that UI needs, without giving up a rule of `AGENTS.md`: everything is a plugin
on the public API, every operation is a command, UI is slots and
contributions. Features of T3 Code that only make sense for its hosted product
(accounts, billing, pairing through a T3 account) are out of scope; what is
left of T3 Code is split into workstreams in `t3-roadmap.md`.

## Decisions

### Reference

- **D53. T3 Code nightly is the reference**: tag
  `v0.1.1-nightly.20261018.3331` (`eb7b35ac`). Components, styles, wording and
  client logic (keybindings, palette search, work-log summaries, prompt
  history, timestamps, status pills) are ported from it; every derived file
  names its origin in a header comment and is covered by
  `THIRD_PARTY_NOTICES.md`. T3's data layer (Effect, zustand, its server
  protocol) is not ported: the data comes from Jhin commands and event logs.

### Agents and threads

- **D54. `agent.runtime@1.1` (additive):** a turn request carries an optional
  model, runtime mode (`approval-required`, `auto-accept-edits`,
  `full-access`; T3's three access modes), interaction mode (`default`,
  `plan`) and image attachments (as data URLs: up to 10 per message, 8 MB
  each and 20 MB together, since they are stored in the turn's first event).
  Besides message deltas a turn yields
  reasoning, tool calls (`kind`, `title`, `detail`, output, status), plan
  updates and token usage, and it can open **requests**: an approval of a tool
  call or questions for the user. A runtime describes itself (`name`,
  `models`, the modes it supports, `status()`). Old runtimes keep working.
- **D55. Several runtimes per node:** the threads plugin provides
  `agent.registry@1`; `agents.list` reports every runtime. A thread records
  its agent, model and modes; `threads.send` defaults to them, can override
  them, and keeps what it used. A node without a choice uses
  `jhin.threads.defaultAgent`, else the first available runtime.
- **D56. Requests are answered through `threads.respond`.** A request is an
  event (`agent.request.opened`/`resolved`); a turn that ends closes its open
  requests without a response, so a client never shows a stale question. While
  a request is open the thread's last turn is `waiting` with `waitingFor`
  (`approval` while one is open, else `user-input`). An answer must be of the
  request's kind, and it counts once it is recorded: only then does the agent
  get it, and an answer that could not be recorded can be sent again. An
  answer to a turn that is ending is refused (`REQUEST_NOT_FOUND`), never
  reported as delivered. An answer that comes while its request is still being
  recorded waits for it, so the log never holds an answer before its request.
- **D57. The thread record says where its latest turn is** (`lastTurn`:
  running, waiting, completed, interrupted, failed, with its time) and when it
  changed (`updatedAt`, `archivedAt`). Every change appends
  `threads.thread.updated` to the `threads` index, so a client follows a
  node's whole catalog from one stream: `threads.catalog` returns projects,
  threads and the index head they reflect. After a restart, turns that were
  running are recorded as interrupted, and their open requests closed. The
  record says a turn runs before the turn's first event is written, so a node
  that stops in between closes that turn too.
- **D58. Thread and project management as commands:** rename, archive and
  unarchive, delete (the stream keeps a final deleted event); a new thread
  takes its title from its first message (hook `threads.title`, run before the
  thread is taken, so a slow hook holds nothing); projects can be created (the
  name defaults to the folder's), renamed and deleted (never the scratch
  project; its threads go with it); `projects.browse` lists folders for the
  project picker (links to folders too, without blocking the node on a slow
  disk), under a permission of its own (`projects.browse`), since it reads any
  folder the node can. Today that permission restricts nothing: every token is
  the owner's (`*`), and mesh members call each other with `*`. A token
  already lets its holder run commands on the node through an agent in
  full-access mode, so listing folders gives it nothing more; the permission
  is there for scoped tokens (Deferred). Paths may start with `~` or `~/` for
  the home directory; `~user` is not expanded.
- **D68. One turn per thread, and none on a thread going away.** Checking that
  a thread is free and reserving it is one step, so concurrent sends start one
  turn. An archived thread takes no messages until it is unarchived
  (`THREAD_ARCHIVED`); no turn starts on a thread while it is being archived
  or deleted, so nothing is written after its deleted event, and no thread is
  created in a project being removed. Archiving and deleting stop a running
  turn; an agent that ignores the interrupt for `STOP_TIMEOUT_MS` (5 s) is
  given up on: its turn is recorded as interrupted and the thread freed, and
  the node stops waiting for the agent's next item and closes its items, so an
  agent that never answers again holds nothing. A turn still starting at that
  deadline is given up on as soon as it has started; a request is always
  recorded opened before its turn's end closes it. Two deletions of one thread
  at once delete it once, and two archives archive it once; an archive keeps
  its own mark, apart from a deletion's, and refuses a thread being deleted
  (`THREAD_NOT_FOUND`), so it never reopens one. A deletion that fails before
  the thread's stream records it leaves the thread as it was; one that fails
  later keeps it closed, and deleting it again finishes the job. Two removals
  of one project at once remove it once; a removal waits for threads being
  created in the project, so none is left behind; a project whose removal
  fails takes new threads again. An answer the agent fails to take stays
  recorded (`AGENT_FAILED`), and the request takes no second one. Changes to
  a thread's or a project's record run one at a time, its removal included,
  so none writes back a record removed meanwhile.

### Client

- **D59. New client capabilities**, each provided by a builtin plugin and
  replaceable: `client.threads@1` (the catalogs of every node and mesh member
  the client reaches, kept current from their indexes), `client.settings@1`
  (the device config layer), `ui.keybindings@1`, `ui.toasts@1`,
  `ui.dialogs@1`, `ui.settings@1` (settings sections are contributions) and
  `client.visits@1` (when each thread was last seen on this device).
- **D60. Config layers on the client:** distribution → node → **device**.
  The node layer is what the node serves (`jhin.ui`, `jhin.keybindings`);
  the device layer is this browser's settings (appearance, chat behaviour,
  notifications, custom keybindings), kept in `localStorage`.
- **D61. Keybindings follow T3 Code's model:** rules `{ key, command, when }`
  with `mod` for ⌘/Ctrl and `when` clauses over context keys that plugins set
  (`composerFocus`, `turnRunning`, `editableFocus`; `terminalFocus` is
  reserved for a terminal plugin). Plugins add defaults; rules in
  `jhin.keybindings` replace the defaults of their command, an empty key
  unbinds. Shortcuts run commands, so a key can run any titled client command.
- **D62. Commands have an optional `title`.** A titled client command without
  required input is an action of the command palette; MCP tools get the title
  too. The palette (⌘/Ctrl+K) also searches projects and threads of every node
  with T3's ranking.
- **D63. React Compiler, as in T3 Code.** Consequence for the code: a render
  reads a store only through a hook that returns the value
  (`useSyncExternalStore`); a store read during render without one is
  memoized and never sees the store change.

### UI

- **D64. Sidebar:** T3's sidebar, since D70 its newer layout: the threads of
  every node the client shows (each connection and each reachable mesh
  member, D47) as one list of cards and a Settled shelf, with their status
  (working, approval, input, failed, done since the last visit), relative
  times, inline rename, a project filter, search and context menus (D69).
  Visits are kept per device and compared with the node's own times.
- **D65. Chat view:** T3's timeline — user bubbles, markdown answers (GFM,
  Shiki highlighting in both themes), a work log per turn with a summary that
  folds behind "Worked for …" once the turn ends, plan cards, failed and
  interrupted turns with their reason and a retry. The composer has the model
  picker, access mode, plan/build toggle, image attachments, a context meter
  from token usage, prompt history (↑/↓), drafts per thread, approval and
  question banners, and a queue of follow-ups sent while a turn runs (client
  side, see Deferred). The chat plugin keeps the queues: each follows its
  thread's record and sends its next message when the record shows the turn
  ended, whether the thread is on screen or not, with the agent, model and
  modes it was typed with. As in T3 Code, a turn that was stopped or failed
  holds the queue until the user resumes it, and a message that is refused
  waits for a retry; the message on its way can no longer be removed. A new
  thread whose first message the node refused is deleted again; when the
  connection dropped the call, the thread stays and offers to send the message
  again until it shows it. An archived thread shows a way to unarchive it
  instead of the composer. The header has a breadcrumb, title actions and the
  slot `chat.header.actions` (props: `ChatHeaderActionProps`).
- **D66. Settings page** with sections as contributions: General, Appearance
  (system/light/dark, chat width), Notifications, Keybindings (record, reset,
  search), Nodes (connections, agents, mesh members), Node config (edit any
  section of the node layer with its JSON Schema; save to several nodes
  through the mesh scope picker, D20, with pending targets, D50) and
  Archived threads. The editor reads through `host.config.get` (a section's
  effective value and what the node and project files set) and
  `host.config.schema`, under the permission `host.config.read`.
  `config-ui.md` (D80–D84) supersedes the JSON editor part: a section is
  edited as a form generated from its schema, with JSON kept as an escape
  hatch.
- **D67. Notifications** when a thread completes, fails, or waits for
  approval or input: with the page in focus, an in-app toast (never for the
  open thread); otherwise a browser notification and/or a sound, as the
  device setting says, and the tab title counts the notifications not yet
  seen.
- **D69. Actions are commands; their menus are slots.** What can be done to
  a thread, a project or a node is a client command taking the node (and the
  remote member) and the id: `thread.rename`, `thread.mark-unread`,
  `thread.copy-id`, `thread.copy-address`, `thread.archive`,
  `thread.unarchive`, `thread.delete`, `project.new-thread`,
  `project.rename`, `project.copy-path`, `project.remove` (the builtin
  `jhin.thread-actions`), `node.rename`, `node.copy-address`,
  `node.disconnect` (the connections plugin) and `project.add`. The menus
  that run them are the slots `thread.actions` (props `ThreadActionProps`;
  the sidebar's context menu and the thread title's menu), `project.actions`
  (`ProjectActionProps`) and `node.actions` (`NodeActionProps`; a node's menu
  in settings → Nodes since D72): the sidebar, the header and settings render
  the slots, so a plugin adds an item, a shortcut or a palette entry the same
  way the builtins do. Saved connections, drafts and
  visits follow the other tabs of the same browser.

### Sidebar follow-up

- **D70. T3's newer sidebar layout, without a section per node.** The
  sidebar lists threads, not a project tree: the threads of every node the
  client shows, connections and the reachable members of their meshes, in
  one list, as T3 Code nightly's default sidebar does. Each active thread is
  a card (T3's `SidebarThreadRow`, "card" variant): the project's icon and
  name on top with, at the right, the thread's status ("Working" with its
  duration, "Approval", "Input", "Failed", or "Done" for a turn that
  completed since the last visit) or else its relative time; the title
  below; a last line with the node's and the agent's icons at its right
  end. A thread that needs nothing from the user fades back, as in T3.
  Active cards are ordered as T3 orders them: newest created first, not by
  activity. Below them, at the bottom of the list, the collapsible
  "Settled" shelf ("Settled (N)" while collapsed, collapsed by default and
  kept per device) lists settled threads as slim rows by when they settled,
  10 at first and 25 more per "Show N more"; collapsed, it still shows the
  open thread. A thread settles as T3 settles one by itself (its default of
  3 days): no activity for three days and no turn running or waiting; it
  settles as of its last activity, the same time its card shows (the latest
  turn, else the record's last change). The shelf and the filter are kept per
  device; a stored value that does not parse or has the wrong type falls
  back to the default. The header holds the search (results
  replace the list, arrow keys and Enter pick one), T3's project filter
  ("All projects" or one project of one node, kept per device), "Add
  project" and "New thread"; a new thread being drafted shows as a draft
  card on top. The context menu of a card or row is the `thread.actions`
  slot, so archiving, renaming and the rest stay commands; a double click
  or F2 renames in place. A node's state shows as alerts above the list, as
  T3 reports its local backends: "Connecting …", "Couldn't connect …",
  "Couldn't load …". One store (`createShownNodes`) follows the
  connections, each connection's mesh and each shown node's catalog; the
  thread shortcuts (`sidebar.thread.*`) count rows in the list's order.
  The "Threads per project" setting goes: no list is per project now.
- **D71. A row names its node only while several nodes are shown.** With one
  node nothing says where a thread lives. With more, a card ends its last
  line with the node's icon, where T3 puts a thread's environment icon (the
  bottom-right corner), and a thread without a project names the node on
  that line, as T3 names the machine of a scratch thread; slim rows end with
  the icon too, and the hover card names the node. The project filter names
  the node next to each project, so two projects called "web" stay apart.
  Accessible names follow: a row is named "title, status, project", and
  while several nodes are shown "… on <node>"; so is the filter's button.
  The icon is the node's machine kind (D130–D133). The agent's icon is Claude's for the Claude Code
  runtime (`jhin.agent-claude`, `providers.md`), as T3 draws its claudeAgent
  provider, and a generic one for any other runtime.
- **D72. The node's actions move where T3 has them.** The header's "Add
  project" (`project.add`) asks on which node when several are shown, as T3
  asks for the environment first; "New thread" (`chat.new`) starts one
  where the user is, and the palette's "New thread in..." lists the projects
  of every node, scratch projects included. Both need an open node.
  Settings → Nodes gives each connection T3's "More actions" menu, which
  renders the `node.actions` slot (still `NodeActionProps`): "New thread
  without a project" and "Add project" join rename, copy address and
  disconnect, under the ids `jhin.sidebar.node.new-thread`,
  `jhin.sidebar.node.add-project` and `jhin.sidebar.node.separator-new`; the
  existing ids are kept. `chat.new-without-project` takes an optional node
  (and remote member), as `project.add` does (additive). In both, `remote`
  needs `node` (the input is refused otherwise), and a named node must be a
  shown, open connection or a reachable member of its mesh
  (`NODE_NOT_FOUND`, `NODE_UNAVAILABLE`); a node whose projects are not
  loaded yet gets no draft (`PROJECT_NOT_FOUND`). Without input they act on
  the current place, and do nothing when its node is not open. Disconnecting
  from that menu leaves the settings page open.
- **D73. Settings leads the sidebar's footer**, as in T3, whose footer starts
  with its utility items; the palette shortcut stays at the right end, where
  T3 shows its update button. An earlier request put settings at the right;
  the user's later reference, T3's sidebar, has it on the left.
- **D74. A dialog's form keeps the dialog's layout.** `DialogPopup` (from
  T3's dialog) lays out a form that is its direct child as a flex column, as
  T3's CustomSnoozeDialog styles its own form. As a block, the form let the
  panel's full-height scroll area take the form's whole height, so the footer
  (Cancel / Rename) sat below the popup as a box of its own; every dialog
  whose content is a form had it (the prompt dialog, "Add project").

- **D75. Settling by hand, kept on the node.** As T3 nightly does, a thread
  is settled and un-settled by hand and the choice is part of its record, so
  every client and device follows it through the `threads` index (D57):
  `threads.settle` and `threads.unsettle` set `settledOverride` (`settled`,
  `active`) with `settledAt` or `unsettledAt`. Settling unpins the thread,
  drops its place among the active threads and wakes it if snoozed (T3's
  drop onto the shelf clears the snooze; otherwise the Snoozed shelf, which
  comes first, would keep showing it), and a thread already on the shelf
  keeps its time there (by the rule: its last activity, as T3 keeps
  `settledAt`); a thread running a turn or
  waiting for an answer is refused (`TURN_IN_PROGRESS`, T3's "Stop it before
  settling" and "Answer it before settling"), and so is an archived one
  (`THREAD_ARCHIVED`). D70's automatic rule stays as the fallback, computed
  by the client: it never settles a thread pinned, snoozed or kept active by
  hand, and it counts a snooze that ended as activity. A new turn clears the
  choice made by hand (T3's turn start), so the rule applies again; a thread
  that was settled, by hand or by the rule (the node runs the same rule, as
  T3's server twin does), comes back with `unsettledAt` set to the turn's
  start, and an active thread sorts by the later of its creation and its
  return, so it is on top of the active cards. A request or a failure always
  belongs to a turn, which brought the thread back when it started. A thread
  whose last turn completed unseen ("Done") settles too, as in T3: its rule
  runs on the server and knows no visits, and here visits are per device,
  where devices must agree. A time that does not parse is no activity to
  settle on: the thread stays active. These fields are the user's
  arrangement, not activity: they leave `updatedAt`, and so the card's time
  and the rule, alone (T3 bumps it, but T3's card shows message times). In
  the client, `thread.settle` and `thread.unsettle` (the builtin
  `jhin.thread-actions`) run them; the `thread.actions` slot gets "Settle
  thread" / "Un-settle thread" (`jhin.thread-actions.settle`), a card offers
  "Settle" and a slim settled row "Un-settle thread" while the pointer rests
  on it, and `sidebar.thread.toggle-settled` (⌘/Ctrl+Shift+S, T3's
  `thread.settle` key) settles the open thread or brings it back. Settling
  and snoozing run through the hook `thread.park` (`THREAD_PARK_HOOK`,
  `ThreadParkInput` in `@jhin/client-api`): the sidebar wraps it to open the
  next card below the thread, else above it, else a new thread in its
  project, when the open thread leaves the cards (T3's settle-and-advance).
  `ThreadActionProps` gets an optional `section`: where the menu's host lists
  the thread, so an item agrees with the list it was opened from (additive).
- **D76. Pinning.** `threads.pin` (with an optional `orderKey`) and
  `threads.unpin` keep `pinnedAt` and `pinOrderKey` on the record. Pinned
  threads are cards on top of the list, by key and then newest first, with
  T3's pin icon on the card's top line; on hover it turns into an "Unpin
  thread" button. As in T3 the pinned block has no header except while a row
  is dragged ("Pinned", "Active"). Pinning a settled thread keeps it active
  by hand (`settledOverride: active`, also for one the rule settled), and
  wakes a snoozed one. The menu's "Pin thread" / "Unpin thread"
  (`jhin.thread-actions.pin`) and ⌘/Ctrl+Shift+P
  (`sidebar.thread.toggle-pinned`, T3's `thread.pin`) run `thread.pin` and
  `thread.unpin`; the latter asks first when the device setting "Unpin"
  (Confirmations, `confirmUnpin`, T3's `confirmThreadUnpin`, off by default)
  says so.
- **D77. Snoozing.** `threads.snooze` takes `until` (an ISO time with its
  offset) and keeps `snoozedUntil` and `snoozedAt`; a time not in the future
  is refused (`SNOOZE_IN_PAST`), as is a thread waiting for an answer
  (`TURN_IN_PROGRESS`); a running one may snooze. Snoozing keeps a pin and
  a settlement, as T3's `thread.snooze` does: the client shows the Snoozed
  shelf first (T3's section order: snoozed, settled, pinned, active), and a
  thread that wakes goes back where it was. Pinning and settling, the other
  way round, wake it (D75, D76), so the latest choice is what shows. `threads.unsnooze` wakes it
  and records `lastSnoozeWakeAt`; a new turn wakes it too. A snoozed thread
  leaves the cards for the "Snoozed" shelf (collapsed by default, kept per
  device, T3's info tone, soonest wake first, each row saying how long is
  left: "45m", "3h", "2d") until its time, or until it raises its hand,
  T3's rule exactly: its turn waits for an answer, or fails or completes
  after it was snoozed (an interrupted turn does not wake it). The node keeps
  the times, the client decides what is awake, as T3 splits it. A thread
  that woke says "Woke" on its card (between "Failed" and "Done") until a
  visit after its wake: the card's "Dismiss Woke notification" records that
  visit, and so does opening the thread. The menu's "Snooze" submenu (T3's
  presets: in 1 hour, in 3 hours, this evening while more than an hour away,
  tomorrow and next week at 9:00, with their times, then "Custom…"),
  disabled while the thread waits for an answer, and the card's clock button
  run `thread.snooze`; without `until` it asks with T3's "Custom snooze"
  dialog (date and time, or a duration), whose date and amount are the
  browser's date and number inputs instead of T3's calendar popover and
  number field. "Wake thread" (menu) and "Wake thread now" (snoozed row) run
  `thread.unsnooze`.
- **D78. Dragging, as T3 nightly drags.** T3's newer sidebar reorders
  threads, not projects (projects keep their manual order only in the
  legacy sidebar): the pinned threads among themselves, the active ones
  among themselves, and a row dropped into another section pins, unpins,
  settles, un-settles or wakes it; nothing drops into the Snoozed shelf,
  since snoozing needs a time. The order is T3's fractional keys
  (`pinOrderKey`, `activeOrderKey`, lowercase letters compared as text), set
  with `threads.reorder` (`list`: pinned or active; refused for a thread
  not pinned, `THREAD_NOT_PINNED`, or pinned or settled,
  `THREAD_NOT_ACTIVE`, so a reorder racing an unpin brings no pin back). A
  drop writes one key between its neighbours, or new keys for the shown
  rows when a neighbour has none, kept clear of the keys of threads not
  shown. Active threads never dragged stay on top, newest first; the
  dragged ones follow by key. A drop runs `sidebar.thread.move` (node,
  thread, section and its index there), so dragging is a command too, and
  the row stays where it was dropped until the nodes have it. Until then, as
  in T3, no row drags, and the dropped row says it is busy (`aria-busy`).
  Rows drag with dnd-kit, T3's library, once the pointer moved 6 px; the
  badge on the dragged row says what the drop does ("Pin", "Unpin", "Settle",
  "Un-settle", "Wake"). A drop is several node commands, one per thread it
  writes, run in turn: one that is refused (another device unpinned a
  neighbour meanwhile, `THREAD_NOT_PINNED`) stops the rest, its error shows
  as a toast, and the list shows what the nodes have; dropping again writes
  the keys anew (one write per drop is deferred). `threads.unsettle` leaves
  a thread that is not settled alone (T3's command would move it to the top
  and switch the rule off for it), and `threads.reorder` refuses an active
  place for a thread on a shelf, settled by the rule or snoozed, so no key
  waits there to place it when it comes back; a drop un-settles or wakes it
  first. As in T3 there is no keyboard dragging: the menu and the shortcuts
  do the same. Collision is dnd-kit's closest centre, not
  T3's own detection around the pinned boundary (Deferred).
- **D79. One clock for the sidebar and its commands.** The list was drawn
  with a minute tick while the shortcuts and `sidebar.thread.*` read
  `Date.now()`, so near a threshold (three days, a snooze's end) a shortcut
  could count rows the user did not see. The sidebar now has one clock
  (`createClock`): renders read its value, commands read the same value
  while the list is shown and the time afresh when nothing shows it. It
  ticks every minute while the page is visible, once more at the next
  snooze's end (T3 schedules that wake too), and reads the time again when
  the threads change, so a thread snoozed "in 1 hour" reads "60m", not a
  minute-old "2h". Menu items take the section from their host (D75); the
  thread title's menu, which has no list, uses the time it opens at. Snooze
  times are not read from this clock: a preset ("in 1 hour") and a custom
  time are reckoned from the moment they are chosen, and the node checks
  `until` against its own clock; a minute-old time would wake a thread up
  to a minute early.

The proof of D70–D74: `apps/web/test/sidebar-order.test.ts` (statuses, Done after a
visit, fading, the settle rule and its activity time, one list across nodes
in T3's order, the project filter, the Settled shelf's paging and collapsed
state, search, accessible names with and without nodes);
`apps/web/test/nodes.test.ts` (which nodes are shown, node names only with
several, the store following and releasing meshes and catalogs, feeds that
answer while it subscribes, several subscribers, a removed connection);
`apps/web/test/sidebar-commands.browser.test.ts` (the sidebar plugin in a test
kernel: `chat.new-without-project` and `project.add` refusing a remote without
its node and nodes not shown or not open, the `sidebar.thread.*` shortcuts
following the list, the shelf and filter kept per device, corrupt stored
values); `apps/web/test/settings.test.ts` (stored chat settings with the
removed setting still read); `apps/web/test/agent-icon.browser.test.tsx`
(Claude's icon for `jhin.agent-claude`, a generic one otherwise); Playwright `e2e/tests/sidebar.spec.ts` (no node
icon with one node, icons and node-named rows with two, the project filter
keeping two "web" projects apart, search, settings leading the footer, the
node picker, the node menu in settings, the rename dialog's footer inside its
panel, and threads settling with the client's clock four days on) and the web
and mesh specs, which use the cards and their context menu.

The proof of D75–D79: `plugins/threads/test/arrangement.test.ts` (settling
and un-settling in the index without touching `updatedAt`, refusals for a
running, waiting or archived thread, settling waking a snoozed thread and
keeping the time a thread the rule settled has on the shelf, a turn bringing a settled thread back
on top and out of the dragged order, a choice by hand giving way to the rule
after a turn, a rename landing while a turn brings the thread back staying,
a thread the rule settled after three days coming back, pin,
reorder and unpin with their refusals and key validation, settling
unpinning, pinning un-settling and waking, snoozing in the future only, not
while waiting, keeping a pin and a settlement under a snooze, waking by hand
or by a turn);
`apps/web/test/sidebar-order.test.ts` (sections and their order, settled by
hand, kept active, pinned, a Done thread settling, an activity time that does
not parse, a snooze's end as activity, waking by time and by a raised hand,
Woke until a visit); `thread-order.test.ts` (fractional keys, rewrites, the
pinned and active order); `sidebar-drag.test.ts` (where a drop lands, nothing
into Snoozed, the drop verbs and plans); `clock.test.ts` (one time for
renders and commands, the wake tick, a hidden page, refreshing);
`snooze.test.ts` (presets, wake labels, custom times);
`sidebar-arrange.browser.test.tsx` (in a test kernel with both plugins:
settling the open thread through `thread.park` opens the card below, else
above, else a new thread; the toggles; `sidebar.thread.move` pinning between
keys, un-settling with keys for the list, settling; the dropped row busy
until the node answers); Playwright
`e2e/tests/sidebar.spec.ts` (settle from a card and the next card opens, a
second browser context seeing it, pin from the menu, snooze from a card, the
shortcut settling a pinned thread, un-settle from the shelf, turns bringing
threads back; a custom snooze, the clock an hour on, "Woke" dismissed or
cleared by opening; dragging pinned and active rows and onto the shelf, kept
after a reload), with screenshots.

### Composer (W6)

T3 Code's composer, ported from the D53 tag (`eb7b35ac`): what the user can
attach, mention and choose for a turn, and what happens to a proposed plan.
It lands as a stack of PRs, each named below with the decisions it carries.

- **D290. One reference, one stack.** Every part follows T3 Code at D53:
  `ChatComposer.tsx`, `ComposerPromptEditorTiptap.tsx`, `ComposerCommandMenu.tsx`,
  `TraitsPicker.tsx`, `ProposedPlanCard.tsx`, `imageCompression.ts`,
  `composerAttachmentFiles.ts` and their server halves. T3's wording, limits
  and keyboard behaviour are kept; where Jhin's architecture differs (commands
  instead of T3's RPC and HTTP routes, a mesh between client and node) the
  decision says how. The stack: the plan card (D304–D306), per-turn model
  options (D297–D299), attachments as blobs (D291–D296), the rich-text editor
  (D303), then commands, skills and mentions (D300–D302).

#### Attachments

- **D291. `storage.blobs@1`: bytes beside the event log.** A capability of
  `@jhin/storage-api`: `put`/`append` bytes under a namespaced key, `read`
  (a range), `stat`, `delete`, `list`, and an optional `path(key)` that names
  the file a blob is kept in when it is a local file. The SQLite storage
  plugin provides it as files in its data directory (written to a `.part`
  file and renamed, so a blob is either whole or absent); the memory storage
  of `@jhin/testing` keeps them in memory, without `path`. Blobs are generic
  storage, not attachments: other plugins (screenshots, exports) use them too.
- **D292. Uploads are commands, in chunks.** T3 mints a signed HTTP URL and
  the browser POSTs the file to it. A Jhin client reaches mesh members only
  through commands relayed by its node, so an upload is commands:
  `attachments.begin` (`{ kind, name, mimeType, sizeBytes }` → `{ attachmentId }`),
  `attachments.write` (`{ attachmentId, offset, data }`, base64 chunks of at
  most 1 MiB, in order) and `attachments.discard`; `attachments.read`
  (`{ attachmentId, offset?, length? }`) returns a range for showing it. The
  threads plugin owns them, under `threads.write` and `threads.read`. The
  limits are T3's (`chatAttachment.ts`): 100 attachments per message, an image
  up to 10 MiB and 80 MiB of images together, a file from 1 byte to 50 MiB,
  with T3's messages ("You can attach up to 100 files per message.", "'X'
  exceeds the 50 MB attachment limit."). An upload not sent within 24 hours
  is swept, as T3 sweeps its pending files.
- **D293. A message refers to its attachments by id.** `TurnAttachment`
  (`agent.runtime@1.2`, additive) is `{ kind: "image" | "file", id, name,
  mimeType, sizeBytes }`; the data URL form of D54 is still accepted and still
  read from older events, so old threads and old clients keep working.
  `threads.send` claims each uploaded attachment for the thread: it checks it
  is complete and within the limits, and moves it under the thread, so an id
  is sent once. Deleting a thread deletes its attachments. The turn's first
  event now holds ids, not bytes: D54's 20 MB per message goes.
- **D294. A runtime gets the bytes and, where there is one, a path.** The
  threads plugin resolves each attachment before the turn starts:
  `read()` for its bytes and `path` when the blob is a local file. Claude
  Code gets images as base64 image blocks, as before, and every attachment's
  path in the text, as T3 writes it (`[Attached file "name" is saved at:
  /path]`); the attachments directory is added to Claude's
  `additionalDirectories` so it can read them.
- **D295. Any file can be attached.** As T3: images (GIF, HEIC, HEIF, JPEG,
  PNG, WebP) show as thumbnails, everything else as a row with its icon, name
  and size, in the composer and in the sent message (where it downloads). A
  paste of 32 KiB of text or more is attached as `pasted-text.txt`
  (`pasted-text-2.txt`, …) with T3's toast; ⌘/Ctrl+Shift+V keeps it inline.
  Uploads start when a file is attached, show their progress, can be retried
  and removed; sending waits for none: a message whose upload did not finish
  is refused with T3's "Attachment 'X' did not finish uploading.". The file
  picker takes any type.
- **D296. Images are made to fit before they are uploaded,** with T3's
  `imageCompression.ts`: PNG and JPEG are scaled to 2000 px on the longest
  edge; an image over 10 MiB is re-encoded (WebP, else JPEG, quality 0.92 down
  to 0.68, then 75 % and 55 % of its size) until it fits; HEIC and HEIF are
  converted to JPEG with `heic-to` (loaded only when one is attached; at most
  64 megapixels). An image that cannot fit says "'X' is too large to attach,
  even after compression.".

#### Per-turn model options

- **D297. A model describes its options** (`agent.runtime@1.2`, additive):
  `AgentModel.options` lists T3's option descriptors, a `select` (`id`,
  `label`, `options` with one `isDefault`, `promptInjectedValues`) or a
  `boolean`. A turn request carries `modelOptions` (`{ id, value }[]`);
  `threads.send` takes them, the thread records them with its model (D55), and
  later turns default to them. `agents.list` reports each model's options.
  Values a model does not declare are dropped, not refused, so a selection
  carried over from another model does no harm.
- **D298. Claude's options are T3's manifest** for the current models:
  Reasoning (`effort`: Low, Medium, High, Extra High, Max, Ultracode where the
  model has it, Ultrathink) and Fast Mode on Opus 5.5; the context window
  options of T3's older 4.6 profiles (200k, 1M) for models Claude Code
  reports with those ids. They apply as T3 applies them: the effort through
  the effort map (Ultracode runs `xhigh` with `ultracode` set, Ultrathink adds
  "Ultrathink:" before the message instead of an effort), Fast Mode as Claude
  Code's `fastMode` setting, a context window as the model id's suffix
  (`[1m]`). The node config's `effort` stays the default when a turn chooses
  none. A live session (`providers.md` D98) whose options change is started
  again; applying them live is W9's (`applyFlagSettings`).
- **D299. T3's traits menu.** One button after the model picker, labelled
  with the chosen values ("High · Fast"), opens a menu with a section per
  select option (radio items, "Default" on the model's default) and On/Off
  for each boolean. A prompt that contains "ultrathink" locks the effort with
  T3's note. The choice is kept per thread like the model, and remembered per
  model on the device for new threads, as T3's sticky options.

#### Commands, skills and mentions

- **D300. A runtime lists its commands and skills** (`agent.runtime@1.2`,
  additive): `AgentRuntime.commands?({ cwd })` returns `{ commands, skills }`
  with T3's shapes (`{ name, description?, input?: { hint } }`, `{ name,
  description?, path, scope?, displayName? }`). The command `agents.commands`
  (`{ agentId?, projectId }`) asks it for a project's folder. Claude Code
  answers from its initialization (`initializationResult().commands`, the
  probe T3 runs, cached per folder for 5 minutes) with T3's `/compact` first;
  its skills are read from `SKILL.md` files under Claude's config directory
  (scope `user`) and the project's `.claude/skills` (scope `project`), as T3
  reads them.
- **D301. The `/` and `$` menus.** As T3: `/` at the start of the prompt
  offers T3's built-ins (`/model`, and `/plan`, `/default` when the agent has
  plan mode), then the runtime's commands, then skills as `/skill:name`;
  `$` offers skills. Picking a command inserts `/name `, a skill `$name `;
  `/plan` and `/default` (picked, or sent alone) switch the mode and `/model`
  opens the picker. Ranking is T3's (`composerSlashCommandSearch.ts`). Claude
  Code runs a skill only when `/name` starts the message's last text block, so
  the runtime sends a `$skill` that way (T3's `ClaudeSkillDispatch.ts`).
- **D302. `@` mentions files and folders of the project.** The command
  `projects.search-entries` (`{ projectId, query, limit ≤ 200, kind? }` →
  `{ entries: { path, kind }[], truncated }`) searches an index of the
  project kept by the threads plugin: the files `git ls-files` lists (tracked
  and untracked, not ignored), else a walk of the folder, and the folders
  they are in, at most 25 000 entries, dropped after 15 minutes unused. T3
  ranks with a native index (`@ff-labs/fff-node`); here T3's own fuzzy scorer
  (`scoreQueryMatch`) ranks the entries. The menu ("Files and folders",
  "Searching workspace files...", "No matching files or folders.") waits
  120 ms after typing, and a pick inserts T3's markdown link
  (`[name](path)`), which the agent reads as text.

#### Rich text

- **D303. The prompt is a tiptap editor,** as T3's
  `ComposerPromptEditorTiptap.tsx`: StarterKit with T3's choices, mention and
  skill chips as inline atoms that serialize back to their text, inline
  markdown marks, lists, quotes and code blocks; the prompt is still a
  markdown string, so drafts, history, the queue and `threads.send` are
  unchanged. Enter sends, Shift+Enter breaks a line, IME composition never
  sends; arrow keys move through prompt history on the first and last line
  only. The menus of D301 and D302 open from the editor's caret.

#### Proposed plans

- **D304. A proposed plan is an item of its own** (`agent.runtime@1.2`,
  additive): `{ kind: "plan.proposed", itemId, markdown }`, recorded as
  `agent.plan.proposed` (`{ turnId, itemId, markdown }`). Claude Code's
  `ExitPlanMode` yields it instead of a message, as T3's adapter captures it.
  The latest plan of a thread's latest turn is the one that can be acted on.
- **D305. T3's plan card:** "Plan" badge and the plan's first heading as its
  title ("Proposed plan" without one), the body without that heading,
  collapsed past 900 characters or 20 lines ("Expand plan", "Collapse plan"),
  and the "Plan actions" menu: "Copy to clipboard", "Download as markdown"
  (the title's slug, `.md`) and "Save to workspace", which writes the file
  into the project through `projects.write-file` (`{ projectId, path,
  contents }`; a relative path inside the project, under `threads.write`).
- **D306. "Implement this plan".** After a plan-mode turn that proposed a
  plan and asks nothing, the composer shows T3's "Plan ready" banner with the
  plan's title. With an empty prompt the send button reads "Implement": it
  sends "PLEASE IMPLEMENT THIS PLAN:\n" and the plan in build mode
  (`interactionMode: "default"`), and its menu ("Implementation actions")
  offers "Implement in a new thread", which creates a thread titled
  "Implement <title>" in the same project with the same agent and model and
  sends it there. With text typed, the button reads "Refine" and sends it in
  plan mode. Both are commands (`chat.plan.implement`,
  `chat.plan.implement-new-thread`).

- **D307–D309.** Free for this workstream's follow-ups.

The proof of D304–D306: `plugins/threads/test/features.test.ts` (a proposed
plan recorded as `agent.plan.proposed`, `projects.write-file` writing inside a
project and refusing `..`, absolute paths, a link out of it and the project
itself); `plugins/agent-claude/test/turn.test.ts` (`ExitPlanMode` yields
`plan.proposed`); `apps/web/test/proposed-plan.test.ts` (T3's title, body,
preview, file name, thread title and prompt; the plan as a timeline item that
never folds away, the latest one offered only after its turn ended and not
after a failure or a later turn, Claude's earlier `:plan` messages read as
plans); Playwright `e2e/tests/composer.spec.ts` (the card, "Plan ready",
saving to the project, "Refine", "Implement" in build mode, "Implement in a
new thread" titled after the plan), with screenshots.

### Node machine icons

- **D130. A node says what it is: `host.identity`.** The node host's
  `jhin.host` plugin answers with the node's id, host name, platform and
  architecture (Node's `process.platform` and `process.arch`) and the
  machine kind clients show it as (`machine`), with the kind it detected
  (`detectedMachine`, absent when it cannot tell). It has a permission of its
  own, `host.identity`, as `host.inspect` has, since the host name says
  something about the machine. How a client holds it: the web client and the
  CLI connect with the node's owner token, which holds every permission
  (`*`), and a call relayed through the mesh runs with `*` too, so a client
  reaches a mesh member's `host.identity` through its connection. A token
  without it (once tokens carry scopes, see Scoped tokens in Deferred) shows
  the node as a server, and the client logs why (D132). The kinds are T3 Code's seven, with T3's labels:
  `server` (Server), `cloud` (Cloud VM), `linux` (Linux/WSL), `desktop`,
  `laptop`, `mac-mini` (Mini PC) and `mac-studio` (Workstation); they live in
  `@jhin/host-api` (`MACHINE_KINDS`, `MACHINE_KIND_LABELS`) and
  `@jhin/client-api` re-exports them for client plugins. Detection is T3's
  (ServerEnvironmentMachine): on Linux the DMI chassis type, any hypervisor
  or cloud vendor in the DMI strings reading as `cloud` whatever chassis it
  fakes, and WSL (its kernel release) as `linux` before that; on macOS the
  IOKit product name, then `hw.model`; on other platforms nothing. T3's
  markers are substrings, kept as broad on purpose: a physical box whose
  vendor or product names a hypervisor or "cloud" reads as a cloud VM, and
  its owner picks the kind (D131). A node
  detects once, on the first ask. A client shows a kind it does not know as a
  server, so a later kind never breaks an older client.
- **D131. The owner's choice is kept on the node, as T3 keeps its
  `environmentIcon` in the server's settings,** not per device: every client
  of a node shows the same icon. It is the `machine` key of a config section
  of its own, `jhin.host` ("Host"), with a title and description, so the
  node config form renders it as a select of the titled kinds (D80, D81).
  The kind shown is the choice, else the detected kind, else `server`; a
  value the schema refuses chooses nothing. The choice is written to the
  node file like every node config edit (D84), so a project file that sets
  the key wins over it.
- **D132. `client.machines@1`, provided by the builtin `jhin.node-machines`,
  tells views each node's kind.** It asks `host.identity` once per followed
  node, a connection or a mesh member (through `mesh.call`), however many
  views follow it, and asks again only when the connection opens again (a
  connection removed and added again counts as opened again), after
  `node.set-machine`, and after the node config page saved
  the `jhin.host` section: the page emits the client event
  `settings.node-config.saved` (`{ connection, section }`) after each save.
  Only the newest answer counts; a node that cannot answer (older than
  `host.identity`), refuses it, or is out of reach shows as a server, or
  keeps the kind it showed, and the views that follow it later do not ask it
  again; the plugin logs each failure of the newest request as a warning
  with the node, the error and its code. The command `node.set-machine`
  (`{ node, remote?, machine }`, "Change node icon") writes the choice to
  the node's `jhin.host` through `host.config.patch`; `machine: null`
  removes it, so the node follows its detection again. A node's menu in
  settings → Nodes gets T3's "Icon" submenu (contribution
  `jhin.node-machines.icon` in `node.actions`): the kinds as radio items,
  the detected one marked "detected" (or "default" when nothing was
  detected); picking the detected kind removes the choice, as T3 does.
- **D133. The node icon is the node's machine wherever it appears**
  (T3's EnvironmentMachineIcon, ported as `MachineIcon` with T3's Mini PC,
  Workstation and Linux icons): the bottom-right icon of a card and of a
  slim row, the hover card and a scratch thread's node line (all only while
  several nodes are shown, D71), the project filter, the add-project node
  picker, settings → Nodes (each connection leads with its machine, as T3's
  EnvironmentRow does, with the connection's state as a dot on its corner,
  and each member of its mesh) and the palette's projects. In the palette a
  project names its node first, then its path (`node · path`), as T3 does,
  with the icon before the node while several nodes are reachable. Every
  icon carries `data-machine` with its kind.

The proof: `packages/node-host/test/machine.test.ts` (chassis types, VMs as
cloud VMs whatever their chassis, WSL before DMI, Macs by product name then
model, the broad hypervisor and cloud markers pinned, nothing on other
platforms or unreadable machines);
`packages/node-host/test/host.test.ts` ("reports what the node is": its own
permission, the owner's kind over the detected one, the section's titled select, unset and
invalid values falling back); `apps/web/test/machines.test.ts` (one request
per node however many follow it, asking again on reconnect (also of a
connection removed and added again), not again for every view of a node
that cannot answer, the newest answer winning, keeping what is known when a node cannot answer, refreshing
a connection or one remote, unknown kinds as servers, a throwing listener,
reporting why the newest request failed);
`apps/web/test/machines.browser.test.tsx` (every kind's own icon, unknown
ones as a server, a view re-rendering when the kind changes,
`node.set-machine` writing and removing `jhin.host.machine` on a node and on
a mesh member, refusing unknown nodes and kinds, asking again after the node
config page saved `jhin.host` and only then, a warning in the log when a
node refuses `host.identity`, the Icon submenu in `node.actions`);
`apps/jhin/test/remote.test.ts` (the owner token the web client uses gets
`host.identity`) and `apps/jhin/test/mesh-nodes.test.ts` (a member's
`host.identity` relayed through the mesh); Playwright `e2e/tests/machines.spec.ts` (a laptop node and
a cloud node: different icons on their cards, in the project filter, the
palette and the add-project picker, none with one node; the Icon menu and
the node config form each changing a node's icon, kept in its node file).

### Sidebar and client follow-ups (W14)

Workstream W14 of `t3-roadmap.md` (D440–D459). The reference is T3 Code
`eb7b35ac` (D53).

- **D441. Conflicting keybindings warn on the settings page**, as T3's
  KeybindingConflictWarning does: a row whose keys another rule has, where
  both can apply, shows T3's amber triangle before its shortcut, named
  "Conflicts with Command palette." (up to three commands, then ", and
  more"), and its tooltip adds "The most recent matching binding wins when
  both conditions can apply." Saving is never blocked. "Both can apply" is
  T3's cheap test: either rule has no `when` (always), or both have the same
  text. Another rule of the same command is no conflict (T3 compares rows
  and would name the row's own command). The keys are compared as the platform presses them
  (`keybindingConflicts` in `apps/web/src/lib/keybindings.ts`, the same key
  the resolver uses to let the last rule win), so `mod+k` and `ctrl+k`
  conflict on Linux, where T3 compares the strings. A search hides rows, not
  their conflicts. T3 also warns while a key is recorded, before saving;
  here a recorded key is saved at once, so the warning follows it.

The proof of D441: `apps/web/test/keybindings.test.ts` ("keybindingConflicts",
conditions that can both apply, keys as pressed on Linux and on a Mac, rules
without a valid shortcut) and `e2e/tests/config.spec.ts` ("D441": giving
"Toggle sidebar" the palette's Ctrl+K warns on both rows, with the tooltip,
and resetting it clears them), with a screenshot.

## Not ported (out of scope)

- T3 accounts, sign-in, billing, hosted environments, and pairing and
  remote access through a T3 account (T3 Connect). Pairing a device with a
  node without T3 is planned (`t3-roadmap.md`, W13), and so is the desktop
  app with its window chrome, native menus and auto update (W18).
- T3's provider settings (API keys, CLI paths): they belong to the agent
  plugins that need them.

## Deferred

- Real agent adapters for Codex and OpenCode. Claude Code is done
  (`docs/plans/providers.md`).
- A server-side message queue and steering: follow-ups wait in the client
  while a turn runs, go out only while the page is open, and are lost if it
  closes.
- Git and source control: done in `source-control.md` (D110–D120) for the
  branch, diff and pull request on the cards, the branch toolbar and the diff
  panel; checkpoints and reverting to a turn, worktrees, git actions
  (commit, push, create a pull request) and linking pull requests to threads
  are deferred there.
- Composer: `@` file mentions, slash commands, rich text (tiptap), pasted
  files other than images, image compression and HEIC conversion (W6, D290–D303,
  in progress).
- Editing a sent message, regenerating, forking a thread.
- Searching thread contents (the palette and the sidebar search titles).
- Sidebar (T3's layout, D70, D75–D79): settling on a merged pull request,
  T3's per-thread "Auto-settle behavior" and its configurable number of days
  (here always 3), the automatic rule applied by the node (T3 sweeps every
  minute; here the client applies it, and the node only at a turn's start),
  one write per drop (a drop is a command per thread it orders, so two
  devices dragging at once, or a failure partway, leave the steps done
  before it; D78), the Working shelf, multi-select and sweeping actions over
  several rows, undo of a pin, T3's own collision detection around the
  pinned boundary, the jump-number hints and discarding a draft from its
  card. The card's branch, diff and pull request are `source-control.md`'s
  D117 and its terminal indicator `terminal.md`'s D148, all in the
  `sidebar.thread.indicators` slot.
- The Icon submenu for mesh members: settings → Nodes lists the members of a
  connection's mesh with their icons, but only a connection has a menu
  (`node.actions` gets `NodeActionProps`, a connection). `node.set-machine`
  takes `remote` already, so a member's kind can be set by command, or in
  the member's node config form; the menu waits for a member menu in
  settings.
- Pushing a node's config changes to its clients: a change of
  `jhin.host.machine` made by hand in the file, from another client, or with
  the mesh scope picker from another node's page reaches a client when its
  connection opens again or the page reloads (D132).
- Visits and drafts are per device; syncing them, and device settings, across
  devices.
- Idempotent thread creation (an id chosen by the client): a
  `threads.create` whose answer the connection dropped can leave an empty
  thread behind.
- One write for a record and its index event: a thread's or project's record
  is written, then its event appended to the index. If the append fails, the
  clients following the index miss that change until they load the catalog
  again (`threads.catalog` reads the records).
- Attachments as blobs: images travel as data URLs inside the turn's first
  event, hence the 20 MB per message (D54).
- Code splitting of the web client: the main chunk is over 500 kB minified.
- Scoped tokens. Done in `security.md` (D410–D416): device tokens carry
  their grants, so `projects.browse`, `host.config.read` and
  `host.identity` are given on purpose, and mesh calls carry their caller's
  scope. `host.config.get` still returns secrets as written (next item).
- Secret config values: no first-party section holds one today. A section
  that does needs a way to mark those values, so that `host.config.get`
  redacts them and the editor keeps them when it saves, before
  `host.config.read` can go to a caller that may not see them. The marker
  exists now (`writeOnly`, `config-ui.md` D83) and the form masks such
  values; the redaction is still to do.

Done since in `terminal.md` (D140–D148): the terminal drawer (node-pty and
xterm.js), the `terminalFocus` context key and the card's terminal indicator.

Done here from the foundation's Deferred list: the settings UI with the scope
picker (D66) and "No project" chats in the UI (D64).

## Landing

One PR. Its parts depend on each other: the threads plugin names threads
after their first message and reports requests, which the previous web client
did not expect, and the new client needs the new commands. It also fixes a
defect of the dev scripts found while proving it with `scripts/t3/smoke.sh`:
`stop.sh` gave up 2 s after it started instead of 2 s after its first
SIGKILL, so on a slow machine it reported processes it had just killed.

Public API it changes beyond the client capabilities (D59): `title` on
`CommandDefinition` and `CommandInfo` (D62, additive); `DisposableStore`
gets `delete(item)` and keeps its items in a set, so an item added twice is
now disposed once; `agent.runtime@1.1` (D54, additive).

**Done when:**

- `pnpm verify` and CI pass; `scripts/t3/smoke.sh` passes.
- Each script of the fake agent shows in the web client as T3 Code shows it:
  reasoning, tool calls and plans in the work log, an approval and questions
  answered from the composer, a stopped and a failed turn with their reason
  (D54–D56, D65).
- A thread's record says where its latest turn is, and every change reaches
  every client through the node's index (D57); a node that restarts closes
  the turns and requests it left open.
- Concurrent sends, archives, deletions and project removals start one turn
  per thread and leave nothing behind; an agent that ignores an interrupt
  holds nothing for more than 5 s (D68).
- The sidebar, palette, keybindings, settings (with the node config editor
  and the mesh scope picker) and notifications work against several nodes
  and mesh members (D59–D64, D66, D67).
- Every action on a thread, a project or a node is a command, and its menus
  are slots that a plugin can add to (D69).
- Every fix made after a review has a test that fails without it.

The proof:

- `plugins/threads` tests: management, titles, projects, agents, tool,
  reasoning and plan items, approvals, questions, interrupts closing requests,
  restart recovery, attachments; concurrent sends, archives, deletions and
  project removals, answers of the wrong kind or not recorded, agents that
  ignore an interrupt (D68); kernel and MCP tests of command titles; the
  node-host test of `host.config.get` and `host.config.schema`.
- `apps/web/test`: keybindings, the timeline (folded at once and as events
  arrive), palette search, prompt history, drafts across tabs, attachment
  limits, status pills and visits, sidebar ordering and filtering, routes, the
  threads store, notifications, starting a thread, the follow-up queues, and
  (browser mode) the node config editor, a thread's timeline following its
  node's client and an unconfirmed first message; `packages/ui` dialogs and
  the clipboard fallback; the kernel's disposal of registrations disposed
  early; `mesh-core`: a relayed call keeps the error code of the node it
  reached.
- Playwright: send and stream, stop, approval, questions, archiving, the
  palette, the inspector, mesh and client plugins, the node config editor
  keeping unsaved edits, with screenshots in the report.
