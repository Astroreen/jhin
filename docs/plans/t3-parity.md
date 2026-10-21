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
  question banners, and a queue of follow-ups sent while a turn runs (kept on
  the node since D201; what follows describes the client queue it replaced).
  The chat plugin kept the queues: each follows its
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
  turn, else the record's last change); since D446 its node settles it, after
  the days it is configured with. The shelf and the filter are kept per
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
  by the client (by the node since D446): it never settles a thread pinned, snoozed or kept active by
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
  "Un-settle", "Wake"). A drop was several node commands (one write since
  D449), one per thread it writes, run in turn: one that is refused (another device unpinned a
  neighbour meanwhile, `THREAD_NOT_PINNED`) stops the rest, its error shows
  as a toast, and the list shows what the nodes have; dropping again writes
  the keys anew (one write per drop since D449). `threads.unsettle` leaves
  a thread that is not settled alone (T3's command would move it to the top
  and switch the rule off for it), and `threads.reorder` refuses an active
  place for a thread on a shelf, settled by the rule or snoozed, so no key
  waits there to place it when it comes back; a drop un-settles or wakes it
  first. As in T3 there is no keyboard dragging: the menu and the shortcuts
  do the same. Collision is T3's own detection around the pinned boundary
  since D448.
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
  (a range), `stat`, `move`, `delete`, `list`, and an optional `path(key)`
  that names the file a blob is kept in when it is a local file. A blob is
  written by `append` at an expected offset, so a chunk sent twice is never
  written twice; an upload counts as whole once its size is the announced
  one, and only a whole one is moved under a thread. The SQLite storage
  plugin provides it as files under `blobs/` in its data directory (every
  name escaped, so no key leaves its folder); the memory storage of
  `@jhin/testing` keeps them in memory, without `path`. The threads plugin
  takes it as optional: a node without it refuses uploads with T3's "This
  node does not support file attachments." Blobs are generic
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
  carried over from another model does no harm. A model its runtime does not list
  (its list not known yet, a model typed by hand) keeps the values as given,
  and the runtime filters them itself.
- **D298. Claude's options are T3's manifest** for the current models:
  Reasoning (`effort`: Low, Medium, High, Extra High, Max, Ultracode where the
  model has it, Ultrathink) and Fast Mode on Opus 5.5; the context window
  options of T3's older 4.6 profiles (200k, 1M) for models Claude Code
  reports with those ids. They apply as T3 applies them: the effort through
  the effort map (Ultracode runs `xhigh` with `ultracode` set), Fast Mode as
  Claude Code's `fastMode` setting (`false` when not chosen, as T3 sends it),
  a context window as the model id's suffix (`[1m]`). Ultrathink is
  `promptInjectedValues`: as in T3, picking it writes "Ultrathink:" before the
  prompt and the effort chosen before stays; a runtime that gets
  `effort: ultrathink` (another client) writes the prefix itself and sends no
  effort. An effort the model does not offer, the config's included, is not
  sent. The node config's `effort` stays the default when a turn chooses
  none. On a live session (`providers.md` D98) a new effort is applied live
  (`applyFlagSettings`, `providers.md` D349) and the model through `setModel`;
  Fast Mode and Ultracode go to it through `applyFlagSettings` too, as T3
  applies them; only a change of thinking starts it again.
- **D299. T3's traits menu.** One button after the model picker, labelled
  with the chosen values ("High · Fast"), opens a menu with a section per
  select option (radio items, "Default" on the model's default) and On/Off
  for each boolean. A prompt that contains "ultrathink" locks the effort with
  T3's note. The choice is kept per thread like the model, and remembered per
  model on the device: a new thread's composer starts a model without chosen
  options with them, as T3's sticky options. `threads.update` keeps only the
  options its model declares, as `threads.send` does; naming the model a
  thread already runs (its agent's default) keeps them.

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
  they are in, at most 25 000 entries, built again when older than 10
  seconds (T3's native index watches the folder instead) and dropped after 15
  minutes unused. T3 ranks with a native index (`@ff-labs/fff-node`); here
  T3's own scorer (`scoreQueryMatch`) ranks them: the name (exact, prefix,
  word boundary, anywhere, fuzzy), then the whole path. An empty `@` asks for
  the first entries, where T3 shows other threads. The menu ("Files and folders",
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
  only. The menus of D301 and D302 open from the editor's caret, as a
  listbox above the composer ("Commands", "Skills", "Files and folders"):
  arrow keys move and wrap, Enter or Tab picks, Escape dismisses until the
  next trigger. The editor is `plugins/chat/prompt-editor.tsx` (tiptap 3.32,
  the version whose React package has its peers; T3 pins 3.31), its pure
  parts `lib/composer-trigger.ts`.

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
  contents }`; a relative path inside the project, under `projects.write`,
  refusing a path that leads out through a link, the file itself included).
- **D306. "Implement this plan".** After a plan-mode turn that proposed a
  plan and asks nothing, the composer shows T3's "Plan ready" banner with the
  plan's title. With an empty prompt the send button reads "Implement", and
  it is the form's submit button, so Enter in the empty composer implements
  too, as in T3: it sends "PLEASE IMPLEMENT THIS PLAN:\n" and the plan in build mode
  (`interactionMode: "default"`), and its menu ("Implementation actions")
  offers "Implement in a new thread", which creates a thread titled
  "Implement <title>" in the same project with the same agent and model and
  sends it there. With text typed, the button reads "Refine" and sends it in
  plan mode. Both are commands (`chat.plan.implement`,
  `chat.plan.implement-new-thread`, on the open thread or the one named);
  a new thread whose first message the connection dropped says so
  (`uncertain`). `agent.runtime@1.2` is a version of the contract, not of a
  manifest entry: its additions are optional fields and items a runtime may
  never use, so a consumer reads them where they are and does without them.

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

The proof of D297–D299: `plugins/threads/test/features.test.ts` (options
listed with their model, kept for the thread's next turns, dropped for another
model, unknown ids, values and duplicates dropped, `threads.update` keeping an
unchanged list without a change); `plugins/agent-claude/test/models.test.ts`
(T3's profiles by id and alias, the effort map, Ultracode, Ultrathink, fast
mode, the config's effort as the fallback, context windows by option and by
suffix, Haiku 4.5's thinking) and `turn.test.ts` (what reaches Claude Code's
query); `apps/web/test/model-options.test.ts` (current values, T3's trigger
labels, Ultrathink in the prompt and out of it, options remembered per model);
Playwright `e2e/tests/composer.spec.ts` (choosing High and Fast Mode, the
turn running with them, Ultrathink written into the prompt), with screenshots.

The proof of D291–D296: the blob contract (`@jhin/storage-api/contract`,
run against memory and files: chunks at an offset, a chunk sent twice
refused, ranges, moves, prefixes, keys with `.`/`..` refused, kept across a
restart) and `plugins/storage-sqlite/test/sqlite.test.ts` (escaped names,
empty folders removed); `plugins/threads/test/attachments.test.ts` (an upload
in chunks, a message refused while one is incomplete, its event holding ids
only, the runtime reading the bytes, reading back a range, a retry to the same
thread, another thread refused, deleting the thread deleting them, T3's
refusals and messages, sweeping day-old uploads, a node without blobs);
`plugins/agent-claude/test/turn.test.ts` (uploaded images as blocks, every
file's path after the text, `additionalDirectories`);
`apps/web/test/uploads.test.ts`, `attachment-files.test.ts`,
`image-compression.test.ts`, `composer.test.ts` (chunks and progress, reading
back, cancelling, one load per attachment; T3's classification, pastes, sizes,
HEIC detection and dimensions, the byte budgets; what fits in a message);
Playwright `e2e/tests/composer.spec.ts` (a text file and an image uploaded,
sent by id, read by the agent, shown and downloaded from the message; a large
paste attached as `pasted-text.txt`), with screenshots.

The proof of D300–D303: `plugins/threads/test/project-entries.test.ts`
(T3's ranking of names and paths, folders as entries, the entry limit, git's
files without the ignored ones, a walk without git, `projects.search-entries`
and `agents.commands` through the plugin); `plugins/agent-claude/test/commands.test.ts`
(the initialization's commands, SKILL.md frontmatter, skills by folder with
the user's first, T3's skill dispatch) and `turn.test.ts` (a `$skill` sent as
the last block's `/skill`); `apps/web/test/composer-menu.test.ts` (the `/` menu's
order and filters, skill search, what a pick inserts);
`apps/web/test/composer-trigger.test.ts` and `prompt-editor.browser.test.tsx`
(triggers, file links, chips that serialize back, Enter and Shift+Enter,
replacing a range, keys the composer takes); Playwright
`e2e/tests/composer.spec.ts` (the `/`, `$` and `@` menus picking a command, a
skill chip and a file chip that reach the agent as their text, `/plan` sent
alone, Escape), with screenshots.

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
  without it (once tokens carry scopes, see `security.md`, D410–D416) shows
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

- **D440. The web client loads its heavy parts on use.** As T3 splits its
  routes and lazy-loads its panels, the message renderer (react-markdown,
  remark-gfm, Shiki), the terminal viewport (xterm.js) and each settings
  section are chunks of their own (`lazyChunk` in
  `apps/web/src/lib/lazy-chunk.tsx`, over `React.lazy`). Until the renderer
  has loaded, a message shows its plain text in the same box; a terminal or
  a settings section shows nothing for that moment. A chunk that fails to
  load (the network, or a node serving a newer build) fails in its place
  only: a message keeps its plain text, a terminal says "Couldn't load the
  terminal." and a section "Couldn't load this section.", each with "Try
  again". A load is one per component: a retry, or the next instance to
  mount after a failure (the next message), starts one new load that every
  instance shows; re-rendering a failed instance starts none. Which load is
  current is kept next to the lazy component, for the page's life: a module
  load cache, which a reload rightly starts over. The page's entry chunk
  went from 1,021 kB to 436 kB minified. The shared `@jhin/ui` module
  (519 kB) stays one chunk: user client plugins import all of it by name
  (D16), so it cannot be split by use. Neither can Shiki's C++ grammar (797 kB), which
  loads only for a C++ code block. The diff panel became a chunk too, loaded
  when it first opens, once the entry chunk had grown back to 500 kB.

The proof of D440: `apps/web/test/lazy-chunk.browser.test.tsx` (the loading
view until the chunk loads, the failed view and a retry, a later mount
loading again, several instances recovering from one retry, no load per
re-render); `e2e/tests/web.spec.ts` ("D440": the entry chunk is under
500 kB without xterm.js or micromark, and a message fetches the markdown
chunk and renders bold text, while xterm.js is never fetched, and a long
thread opened afresh is still at its end once its markdown is in); the browser
tests of the timeline, the terminal and the settings pages, and
`e2e/tests/terminal.spec.ts`, which render the lazy parts.

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

- **D442. A mesh member has a menu too, with T3's Icon submenu.** T3 gives
  every saved environment its "More actions" menu with "Icon" first. In
  settings → Nodes each member of a connection's mesh gets a "More actions
  for <name>" menu, which renders the new slot `node.member.actions`
  (`NodeMemberActionProps`: the connection and the member, additive). It is
  a slot of its own, not `node.actions`: the connection's items (rename on
  this device, copy address, disconnect) and any plugin's would act on the
  connection. `jhin.node-machines` contributes the same Icon submenu there
  (`jhin.node-machines.member-icon`). It runs `node.set-machine` with
  `remote`, which writes the member's own node file through the mesh, so the
  member shows the kind to every client, as T3 keeps the icon on the
  environment's server. An unreachable member's menu says "Connect to this
  node to change its icon." and its kinds are disabled. Without a
  contribution to the slot (hidden ones do not count) the member has no
  menu button; a contribution that renders nothing still counts.

The proof of D442: `apps/web/test/machines.browser.test.tsx` (the submenu in
both slots; a member's submenu setting the kind on the member, and doing
nothing while the member is out of reach) and `e2e/tests/mesh.spec.ts` ("D442": a and b in one mesh, b's
menu in a's settings changes b's icon, kept in b's node file; once b is
stopped its menu says so and its kinds are disabled), with a screenshot.

- **D443. The hover card names the thread's branch and warns when another
  one is checked out**, as T3's SidebarThreadTooltip does: a line with the
  branch (GitBranchIcon, middle-truncated) and under it, in the warning
  tone, "You're currently checked out on another branch." when the
  project's checkout has a branch and it is not the thread's (T3's
  resolveLocalCheckoutBranchMismatch). The lines come from the new slot
  `sidebar.thread.details` (`THREAD_DETAILS_SLOT` in `@jhin/client-api`,
  the props of `sidebar.thread.indicators`), placed after the project and
  the node and before the agent; `jhin.source-control` contributes
  `jhin.source-control.branch-detail` and
  `jhin.source-control.branch-mismatch`. T3 leaves a thread with a worktree
  of its own out: here no thread has one yet (`source-control.md`, W3), and
  the rule takes that exception when it does.

The proof of D443: `apps/web/test/source-control.browser.test.tsx` (the
branch line and the warning; none while the branch is checked out, without
a branch, a repository or a checked-out branch) and
`e2e/tests/source-control.spec.ts` (git switches the project's checkout
under the thread, the hover card warns after the project and branch lines,
and stops once switched back), with a screenshot.

- **D444. The settle rule is the node's config**, as T3's "Organization"
  settings are its server's: three keys of `jhin.threads`, with T3's titles
  and descriptions, so the node config form renders them (D80):
  `autoSettleOnMerge` ("Auto-settle merged threads", on),
  `autoSettleInactive` ("Auto-settle inactive threads", on) and
  `autoSettleAfterDays` ("Days of inactivity before auto-settle", 1–90,
  3). T3 keeps the days as one nullable number behind a switch; here the
  switch is a key of its own, so each is a plain form field.

- **D445. Auto-settle per thread.** T3's "Auto-settle behavior" submenu
  ("Enabled", "Disabled", as radio items, timer icon) in `thread.actions`
  (`jhin.thread-actions.auto-settle`, before the copy items, as T3 places it
  before "Copy") runs `thread.set-auto-settle`, which runs
  `threads.set-auto-settle { threadId, enabled }`. The record keeps
  `autoSettleDisabledAt` while it is off (T3's field); the node then never
  settles the thread by itself, by inactivity or by a pull request, while
  settling by hand still works. Like the rest of the arrangement it leaves
  `updatedAt` alone. A failure toasts "Failed to update auto-settle".

- **D446. The node sweeps; the client settles nothing by itself.** As T3's
  ThreadSettlementService does, the threads plugin settles every thread its
  rule settles: every minute, when the rule's config changes, at start and
  on `threads.sweep`. A thread settles when it may (not settled or kept
  active by hand, archived, pinned, with auto-settle off, running, waiting
  or snoozed) and saw no activity for the configured days; it is written
  with `settledOverride: "settled"` and `settledAt` its last activity (T3
  records the activity time too), the same event a settle by hand writes.
  The client lists only what the node wrote, as T3's client reads
  `settledOverride`: D70's client rule, fixed at three days, goes, since
  only the node knows its days. The rule the node already applied at a
  turn's start and on its own commands (D75) now reads the same config.

- **D447. A merged or closed pull request settles its thread.**
  `jhin.source-control` asks `gh` for the pull request of each thread's
  branch (D116); when one is newly seen merged or closed it runs
  `threads.auto-settle { threadId, reason, closedAt }` for every thread on
  that branch. The threads plugin decides, as T3's pullRequestSettles does:
  a merged one only while `autoSettleOnMerge` is on, a closed one always,
  never a thread the rule may not settle (D446), and only when it closed at
  or after the user's last message to the thread (`lastMessageAt`, new on
  the record, T3's latestUserMessageAt) and its creation. `PullRequest`
  gains `closedAt` (`gh`'s field, additive). Nothing un-settles a thread
  whose pull request reopens, as in T3.

The proof of D444–D447: `plugins/threads/test/auto-settle.test.ts` (the
sweep after the configured days as of the last activity, never a pinned
thread or one with auto-settle off; no sweep while the rule is off and one
once it is switched on; turning auto-settle off and on without activity; a
merged pull request after the last message settling, one from before not; a
merged one left alone while `autoSettleOnMerge` is off and a closed one
settling; none for a pinned thread, one with auto-settle off or one kept
active by hand); `plugins/source-control/test/github.test.ts` (a thread
settling when its branch's pull request merges); `apps/web/test/sidebar-order.test.ts`
(the client settling nothing by itself); `e2e/tests/sidebar.spec.ts` ("D70,
D446": threads the node settles going onto the shelf live; "D445": the
submenu turning auto-settle off on the node, after which a closed pull
request settles nothing), with screenshots.

- **D448. T3's own collision detection around the pinned boundary.** A row
  dragged near the divider between the pinned and the active threads uses
  T3's createSidebarCollisionDetection (`createSidebarCollisionDetection` in
  `apps/web/src/lib/sidebar-drag.ts`) instead of dnd-kit's plain closest
  centre: over the divider's label (`sidebar-drag-boundary-label`, measured
  live) the side changes only when the pointer moves across it, up into the
  pinned threads or down into the active ones, so a still pointer never
  flips back as the destination opens; and a nearest target where the drop
  would do nothing (`planDrop` says `none`) leaves the row where it is.
- **D449. One write per drop.** `threads.arrange { steps }` runs several
  arrangement steps (settle, unsettle, pin, unpin, unsnooze, reorder) as
  one command: it holds every record the steps touch (in one order, so two
  drops never wait on each other), checks and changes them in memory with
  the single commands' own rules (`changes.*` in the threads plugin), and
  writes only when every step held: the records and their index events in
  one transaction (`storage.eventlog@1.1`'s records, D208).
  A step refused (another device unpinned a neighbour meanwhile,
  `THREAD_NOT_PINNED`) leaves every thread as it was. `sidebar.thread.move`
  sends one `threads.arrange` per node the drop touches, the dropped
  thread's node first; a drop onto the Settled shelf stays `thread.settle`
  (one step, through `thread.park`). The single commands stay. A failure
  toasts T3's titles ("Failed to pin thread", "Failed to unpin thread",
  "Failed to un-settle thread", "Failed to wake thread", "Failed to reorder
  pinned threads", "Failed to reorder active threads"). T3 itself writes a
  drop as several commands; this closes D78's gap. A drop across nodes is
  one write per node.

The proof of D448–D449: `apps/web/test/sidebar-drag.test.ts` (the side
sticking to the last crossing, against closest centre, and a drop that does
nothing leaving the row in place); `plugins/threads/test/arrangement.test.ts`
("a drop as one write": the steps' records appended in one batch, a refused
step leaving every thread as it was, no write for steps that change
nothing); `apps/web/test/sidebar-arrange.browser.test.tsx` (one
`threads.arrange` per drop with its steps, nothing landing when a step is
refused); `e2e/tests/sidebar.spec.ts` (the drag test, twice).

- **D450. T3's undo notice.** Unpinning, settling, snoozing and archiving
  a thread through its commands (`thread.unpin`, `thread.settle`,
  `thread.snooze`, `thread.archive`: the card's buttons, the menu, the
  shortcuts) offer their undo at the top of the sidebar's footer, as T3's
  SidebarThreadUndoNotice does: "Unpinned 1 thread, Ctrl+Z to undo" (the
  shortcut's label, else "Undo"), a status line in the sidebar's alert
  tone, for 5 seconds after the latest action. Consecutive actions of one
  kind group ("Settled 2 threads") and one undo restores the group; the
  command `thread.undo` ("Undo", ⌘/Ctrl+Z while neither a terminal nor an
  editable field has focus, T3's binding) runs it. What undo does is T3's:
  an unpin pins again at its old key, a settle un-settles and pins and
  snoozes again what it unpinned and woke (in one `threads.arrange` for
  the first two, D449), a snooze wakes, an archive unarchives; a failure
  toasts T3's titles ("Failed to undo unpin", "Failed to undo settle",
  "Failed to wake thread", "Failed to undo archive"). An action that undoes
  another by hand (pin after an unpin, un-settle, wake, unarchive) voids
  its undo, as T3's ThreadUndo claims do. Archiving's former "Thread
  archived" toast with its Undo button goes; the notice replaces it. The
  notice is a contribution (`jhin.thread-actions.undo-notice`) to the new
  slot `sidebar.notices` (`SIDEBAR_NOTICES_SLOT`), and the undo itself is
  the capability `client.undo@1` (`UNDO_CAPABILITY`, `ThreadUndoService`
  in `@jhin/client-api`), provided by `jhin.thread-actions`, so another
  plugin's action can offer its undo the same way: it names what was done
  and to what (`action`, `noun`) and which undos its success voids
  (`voids`). T3 offers no undo for
  pinning, and neither does this: "undo of a pin" is the undo of an unpin.
- **D451. Discarding a draft from its card.** The card of a new thread's
  draft gets T3's "Discard draft" button (an X shown while the pointer
  rests on the card, with that tooltip). It runs `chat.draft.discard`
  (`node`, `remote?`, `projectId`), which leaves the draft if it is open and
  clears its text and images, with no question asked, and offers its undo
  through `client.undo@1`: "Discarded 1 draft". Undo brings the text back
  and opens the draft again, unless the draft has new text meanwhile:
  "Failed to restore draft", "The draft has new content." (T3's words).

The proof of D450–D451: `apps/web/test/thread-undo.test.ts` (the notice's
words and grouping, one undo per group, the run before it next, expiry
after five seconds, a voided undo, a claim a later action took, a failed
undo's title); `e2e/tests/sidebar.spec.ts` ("D450": unpin from the card and
Ctrl+Z pinning it again at its key, settle and the notice's button bringing
it back pinned, archive and undo; "D451": a draft discarded from its card,
the notice, and undo bringing back its text), with screenshots.

- **D452. T3's Working section (beta), a device setting.** Settings →
  General → Organization gets T3's "Working section (beta)" ("Fold working
  and monitoring threads into a Working section. They return to the top of
  the inbox when they need you."), `workingSection` of the chat settings,
  off by default. On, an active thread whose turn runs (T3's
  isThreadWorking; one waiting for an answer needs the user and stays)
  leaves the inbox for a "Working" section below it (`working`, a new
  `ThreadSection`, additive): T3's muted header, "Working (N)" while
  collapsed, collapsed by default and kept per device
  (`jhin.sidebar.working-expanded`), the open thread still shown when
  collapsed, cards newest sent first (the later of creation and
  `lastMessageAt`). Pinned threads stay pinned. Nothing drops into it and its
  rows do not drag, as in T3. A thread back from it (its turn ended or asks
  for something) is on top of the inbox: T3's return tracker, read from the
  record (`lastTurn.at` of a turn no longer running) instead of remembered.
  While it is on, the inbox is ordered by time, not by hand (T3's
  activeTimeOrdered): dragged keys wait until it is off again.
  The shortcuts count its shown rows between the inbox and the shelves.

The proof of D452: `apps/web/test/sidebar-order.test.ts` ("the Working
section": off by default; running threads folded, newest sent first, pinned
and asking ones left; a returned thread on top of the inbox) and
`e2e/tests/sidebar.spec.ts` ("D452": the setting on, "Working (1)",
expanded, and the thread back on top once its turn is stopped), with a
screenshot.

- **D453. Jump-number hints.** As T3 does, holding the modifiers of the
  `sidebar.thread.jump.1…9` shortcuts (⌘ on a Mac, Ctrl elsewhere; exactly
  those, `holdsShortcutModifiers` in `apps/web/src/lib/keybindings.ts`) for
  200 ms shows each of the first nine rows' shortcut in T3's round badge at
  its right ("Ctrl+1"), the rows counted as the shortcuts count them (D79:
  pinned, active, Working, the shown shelves). Releasing them, or the window
  losing focus, hides them at once; a focused terminal shows none, since it
  owns the keys. A row whose command has no shortcut gets no badge. T3 binds
  the jumps on its desktop app only; here they are bound in the browser too
  (D70), so the hints show there.

The proof of D453: `apps/web/test/keybindings.test.ts` ("holdsShortcutModifiers":
exactly the jump modifiers per platform, other commands not counted) and
`e2e/tests/sidebar.spec.ts` ("D453": Ctrl held shows Ctrl+1–3 on the rows,
Ctrl+2 opens the second, releasing hides them), with a screenshot.

- **D454. Multi-select, as T3 selects rows.** ⌘-click on a Mac (Ctrl-click
  elsewhere) adds a row to the selection or takes it out, Shift-click adds
  the rows from the last one picked to it (the list's order, additive), a
  plain click opens a thread and ends the selection, Escape clears it.
  Selected rows take T3's selected background (`bg-sidebar-row-selected`)
  and `data-selected`. The context menu of a row in a selection of two or
  more is T3's selection menu instead of `thread.actions`: the new slot
  `thread.selection.actions` (`ThreadSelectionActionProps`: the selected
  threads, additive), where the sidebar contributes
  `jhin.sidebar.selection.unpin`, `.settle`, `.snooze`, `.mark-unread`,
  `.separator` and `.delete`: "Unpin (N)"
  (while any is pinned), "Settle (N)" (disabled when all are settled),
  "Snooze (N)" with T3's presets "label (when)" (while every one can
  snooze), "Mark unread (N)" and "Delete (N)" (destructive, asking "Delete N
  threads?" / "This permanently clears conversation history for these
  threads." when the Delete confirmation is on). Each is a command acting on
  the selection (`sidebar.selection.unpin`, `.settle`, `.snooze { until }`,
  `.mark-unread`, `.delete`, `.clear`) that runs the single thread's command
  for each thread, so the undo notice groups them ("Settled 3 threads"),
  then clears the selection; failures toast T3's titles ("Failed to snooze
  N threads", "Failed to delete threads").

The proof of D454: `e2e/tests/sidebar.spec.ts` ("D454": Ctrl-click, Escape,
Shift-click range, the selection menu, "Settle (3)" landing three threads on
the shelf with one grouped notice, a plain click back to the thread's own
menu; "Mark unread (2)", and "Delete (2)" asking once and deleting both on
the node), with a screenshot.

- **D455. T3's sweep.** Pressing a row's "Settle thread" (a card),
  "Un-settle thread" (a settled row) or "Wake thread now" (a snoozed row)
  button and moving the pointer more than 6 px up or down sweeps the rows
  of that section between the button's row and the one under the pointer:
  they take the selected background and, in place of their time, the badge a
  drop would show ("Settle", "Un-settle", "Wake"). Releasing runs the
  button's command (`thread.settle`, `thread.unsettle`, `thread.unsnooze`)
  for each swept thread in the list's order, so the undo notice groups them
  ("Settled 3 threads"); a press that does not move is the button's click.
  Leaving the section's rows keeps the last range. T3 runs only the actions
  the thread's node supports; every Jhin node has these.

The proof of D455: `e2e/tests/sidebar.spec.ts` ("D455": Settle pressed on
the first card and swept over three, the badges while sweeping, the three on
the shelf and one grouped notice after release), with a screenshot.

### Server-side queue and steering (W1, `t3-roadmap.md`)

- **D200. The reference is T3 Code's server queue** (D53's tag,
  `eb7b35ac`): `apps/server/src/orchestration-v2/Orchestrator.ts` (queued runs
  with a `queuePosition`, `queueHeld` after a stop or a failure,
  `queue.resume`, `queued-run.edit`, `queued-run.reorder`,
  `queued-run.cancel`, `queued-message.promote-to-steer`), `QueuedRunOrder.ts`,
  the client's `QueuedRunsControl.tsx` and `composerDispatch.ts` (the
  "Follow-up behavior" setting), and `ClaudeAdapterV2.ts` (`steerTurn`). T3's
  automatic completion deliveries (delegated tasks) and restarts of a turn
  with the new message are not part of it (W10 and Deferred).
- **D201. A thread's queue lives on its node.** A message sent while the
  thread runs a turn is stored in the node's `storage.kv`
  (`jhin.threads`, `queue/<threadId>`) with the agent, model and modes it
  was typed with, so it outlives the page that sent it and a restart of the
  node. `threads.queue.add` (`threadId`, `text`, `attachments?`, the agent
  settings, an optional `messageId` the caller chooses) starts a turn at once
  when the thread is free and its queue empty and not held, and answers
  `{ messageId, turnId }`; otherwise the message joins the end of the queue
  (`{ messageId }`). Adding a `messageId` still queued changes nothing; one
  that already left the queue is taken again (see Deferred). Each
  change of the queue appends `threads.queue.updated` to the thread's stream
  with the whole queue (`messages` in order, each with its text, settings,
  times and its attachments' names and types; the images stay in the
  record) and `held`, so a client follows a thread's queue from the stream it
  already reads, and `threads.queue.list` returns it with the images.
- **D202. Delivery, and a queue held as T3 holds it.** When a turn ends the
  node starts the first queued message as the thread's next turn, through
  the same path as `threads.send` (titles, settings, D68's reservation): the
  message leaves the queue in the same write that records its turn's start,
  so a crash leaves it in the queue or in a turn, never in neither; one the
  node refuses stays first. A turn that was
  interrupted or failed, also one the node closed after a restart, holds
  the queue (`held: { reason: "interrupted" | "failed", turnId }`), as T3's
  `queueHeld` does after a stop, until `threads.queue.resume`; the hold is
  written with the turn's last event, so no queued message starts after it. A queued
  message the node cannot start (the thread archived, its agent gone) stays
  first and holds the queue with `reason: "refused"` and the error; resuming
  tries it again. Archiving a thread stops its turn, so its queue is held;
  deleting it drops the queue. When the node starts, every free thread with
  a queue that is not held starts its next message; a queue the user resumed
  past its stopped or failed turn (`resumedPast`) is not held again.
- **D203. Editing, reordering and cancelling queued messages**, T3's
  commands: `threads.queue.edit` (`messageId`, `text`, `attachments?`:
  absent keeps the images, `[]` removes them; a message left with neither
  text nor images is refused, `MESSAGE_EMPTY`),
  `threads.queue.reorder` (`messageId`, `beforeMessageId`: the message it
  goes before, `null` for the end) and `threads.queue.cancel`. A message not
  in the queue (sent or cancelled meanwhile) is `QUEUED_MESSAGE_NOT_FOUND`.
  Changes to a queue run one at a time, its delivery included, so a reorder
  and the delivery of the first message never cross.
- **D204. `agent.runtime@1.2` (additive): steering.** A runtime that takes
  messages into a running turn says so (`steering: true`) and its turns have
  `steer(input)`: synchronous, it hands the message to the running turn, or
  throws when the turn can take nothing more (it ended or is ending).
  `agents.list` reports `steering`. The fake agent steers: a `/hold` turn
  steered answers "Echo: <message>" and completes.
- **D205. `threads.steer` and `threads.queue.steer`.** `threads.steer` sends
  a message into the thread's running turn; the turn records it as
  `agent.turn.steered` (`{ turnId, messageId, input }`) right after the agent
  took it, before anything the agent answers to it. On a free thread it
  starts a turn at once, as `threads.send` does, also past a held queue (it
  is the user's newest message); when the turn ends before the
  agent took the message, the message is queued first instead, as T3 starts
  the follow-up turn when a steer comes too late. The answer says which
  (`outcome`: `steered`, `started`, `queued`). An agent that cannot steer
  refuses it (`STEER_UNSUPPORTED`). `threads.queue.steer` (T3's
  promote-to-steer) moves a queued message into the running turn the same
  way; it leaves the queue in the write that records the steer, and without a running
  turn it is refused (`TURN_NOT_RUNNING`). The queue is locked only to read
  the message and to remove it, not while the agent takes it, and the message
  does not start a turn of its own meanwhile.
- **D206. Steering Claude Code**, as T3's `steerTurn`: the message goes into
  the live query the turn holds (D98) as a user message with
  `priority: "now"`. Claude Code then ends its current response with a
  result whose `terminal_reason` is `aborted_streaming` or `aborted_tools`;
  that result does not end the turn, which goes on with the steer. Frames
  marked with the steer's uuid are the turn's, and the turn ends at the
  first result after its last steer that is not such an abort, or at the
  result it passed over when Claude Code reports idle with nothing more. A steer that
  comes while the turn waits for its Claude Code goes in right after the
  turn's message; one after the turn read its result is refused. T3's move of
  foreground subagents to the background before a steer is not ported
  (Deferred).
- **D207. `threads.create` with an id the caller chooses** (`threadId`,
  letters, digits, `_` and `-`, up to 128) is idempotent: asked again with
  the same id and project it returns the thread it made as it is (a later
  call's title and agent settings change nothing), also when two calls come
  at once. An id of another project's thread or of a deleted
  thread is refused (`THREAD_EXISTS`). A creation that stopped after the
  thread's first event is finished by the next call with that id, with the
  thread that event recorded, and a deletion that stopped after the stream
  said deleted is finished when the node starts (its record removed and
  announced). The web client chooses the id of every thread
  it starts and asks again with it when the connection dropped the answer;
  after any other failure the draft takes a new id, since a thread deleted
  after its refused first message keeps its id taken.
- **D208. One write for a record and its index event:
  `storage.eventlog@1.1`** (additive) takes `records` with an append: entries
  of the `storage.kv` the same plugin provides, set or deleted in the same
  transaction as the events. The threads plugin requires it and writes each
  thread and project record together with its `threads` index event, so a
  client following the index never misses a change the records show
  (`threads.catalog`), nor sees one they do not. A thread's deletion keeps
  its record until the index announces it; the thread takes no messages
  meanwhile (D68). SQLite and the in-memory storage implement it. The records
  go to the store the event log belongs to, so `storage.kv` and
  `storage.eventlog` must come from one plugin: the threads plugin checks
  that when it starts, with an append of no events and one record, and
  refuses to start otherwise (`STORAGE_MISMATCH`). A creation that loses the
  race for its id to another process sharing the storage (`CONFLICT` on the
  stream's first event) looks at the stream again, as a second call would.
- **D209. The composer queues or steers, as T3's "Follow-up behavior"
  says.** While a turn runs, sending queues the message (the device setting
  "Follow-up behavior": Queue, the default, or Steer) and ⌘/Ctrl+Enter
  (⌘/Ctrl+Shift+Enter when ⌘/Ctrl+Enter sends; the command
  `chat.composer.send-alternate`, T3's `composer.sendAlternate`) does the
  other for one message. The send button says which ("Queue message",
  "Steer message"). Steering falls back to queueing for an agent that
  cannot steer. The client's own queue goes: the composer calls
  `threads.queue.add` or `threads.steer`, and a thread's queue is what its
  stream's last `threads.queue.updated` says, on every client of the node.
- **D210. The queue banner is T3's `QueuedRunsControl`.** "Queued" with the
  count above the composer; each row has a grip to drag it or move it with
  ↑/↓ ("Reorder queued message (drag, or press the arrow keys)"), "Edit
  queued message" (the composer takes its text and images, saving runs
  `threads.queue.edit`, "Cancel" leaves it), "Steer" (enabled while the
  running turn's agent steers; "Send as a steer instead") and "Remove from
  queue". A held queue says why ("The turn was stopped", "The turn failed",
  or the refusal) with "Resume". Client commands with T3's keys:
  `chat.queue.steer-next` (⌘/Ctrl+Shift+Enter, T3's
  `thread.steerQueuedMessage`) and `chat.queue.edit-latest` (Alt+↑ with the
  caret at the composer's start, T3's `thread.editQueuedMessage`). A steered
  message shows in the timeline as a user message inside its turn.
- **D211. Public API this adds:** the commands `threads.queue.add`,
  `threads.queue.list`, `threads.queue.edit`, `threads.queue.reorder`,
  `threads.queue.cancel`, `threads.queue.resume`, `threads.queue.steer` and
  `threads.steer`; `threadId` of `threads.create`; the events
  `threads.queue.updated` and `agent.turn.steered`; `agent.runtime@1.2`
  (`steering`, `AgentTurn.steer`); `storage.eventlog@1.1` (`records`); the
  error codes `QUEUED_MESSAGE_NOT_FOUND`, `STEER_UNSUPPORTED`,
  `TURN_NOT_RUNNING`, `STEER_IN_PROGRESS` and `THREAD_EXISTS`, and `STORAGE_MISMATCH` when the
  threads plugin starts; `messageId` on `agent.turn.started` for a queued
  message's turn. `threads.send` keeps refusing a busy thread
  (`TURN_IN_PROGRESS`).

### Thread history (W2)

T3 Code (D53, and nightly `v0.1.1-nightly.20261020.3411`, which adds
nothing here) has no in-place edit and no regenerate button: a sent message
is edited by rewinding the chat to before it ("Edit from here"), a stopped
or failed turn is resumed, a thread forks from an answer and a fork merges
back into its parent, and a server-side search reads the messages of every
thread. Those are ported; regenerating is the one addition the roadmap asks
for, built from the same rewind.

- **D220. A thread drops its later turns with `threads.rollback`**
  (`{ threadId, turnId? }`): the turns after `turnId` go, every turn without
  it (T3's `checkpoint.rollback` to a turn count, without the files, which
  W3 adds). The log stays append-only: the thread's stream gets
  `threads.thread.rolled-back` (`{ turnIds, toTurnId? }`, the turns dropped,
  oldest first), and nothing is rewritten, so catching up by sequence (D29)
  and mirrored history (D26) keep working. The record's `lastTurn` becomes
  the kept turn's (its ending and time) or goes, and `updatedAt` moves; the
  index event follows. Refused while a turn runs or starts
  (`TURN_IN_PROGRESS`: a rollback and a send take the thread the same way, so
  neither starts in the other's middle), on an archived thread
  (`THREAD_ARCHIVED`) and for a turn the thread does not show
  (`TURN_NOT_FOUND`, a dropped one included); nothing after `turnId` drops
  nothing and appends nothing. The event and the record are two writes: a
  record left naming a dropped turn (its write failed after the event) is
  mended by the next rollback, which then finds nothing to drop. A deletion
  or an archive waits for a rollback under way however long its hook runs
  (a stop gives up on an agent after `STOP_TIMEOUT_MS`, but still waits for
  its hold to end). A message sent while a rollback holds the thread waits
  in the thread's queue and starts once the rollback is done (D202). It runs through the hook `threads.rollback`
  (`{ thread, toTurnId?, turnIds }`, around the recording), so W3's
  checkpoints restore the files of the same rollback; a hook may delay or
  refuse it, not change which turns it drops.
- **D221. A dropped turn is gone for every reader.** `@jhin/agent-api`
  exports `visibleThreadEvents(events)`: the events without those of dropped
  turns and without the rollback events. A turn request's `history` is that
  (the threads plugin provides `agent.registry@1.1`: "every earlier event the thread still shows"), and so
  is what forks copy and search reads; the client's timeline removes the
  dropped turns as their event arrives. Turn ids are UUIDs, so a dropped id
  never comes back.
- **D222. Claude Code forgets what was dropped.** Claude keeps its own
  session (D91), which still holds the dropped turns. The session record
  keeps the session id and the turn that last used it; a turn whose history
  no longer shows that turn starts a new session (a new id, its live process
  closed) with the thread's whole transcript as context, T3's
  `portable_context`. Old records (no id) mean the thread's id, as before.
  The record is written once Claude Code starts the turn, and a write that
  fails is only logged (D91): a dropped turn whose record was never written
  leaves the record naming an older turn, and the next turn resumes the
  session with the dropped turn in it. That gap is accepted until the native
  rewind below, which needs no record. So is a record written before this
  change (no turn in it) when the thread is rolled back before its next
  Claude turn: that turn resumes the old session once, and records its turn
  from then on.
  T3's native path (`resumeSessionAt` the kept answer's message) is
  deferred: it needs the SDK's message ids on every turn.
- **D223. "Edit from here"** (T3's `RevertUserMessageButton`): the hover row
  of a sent message gets `Undo2Icon` "Edit from here" while no turn runs.
  It asks "Edit from here?" / "Rewind chat to before this message. Your
  prompt and attachments return to the composer." with "Cancel" and "Revert
  and keep changes" (W3 adds "Revert files too"), rolls back to before the
  turn and puts the text after the composer's draft (a blank line between)
  and the images back into the composer; nothing is sent. The node does the
  parts that must agree: `threads.turn` (`{ threadId, turnId }`) tells a
  turn's message and settings, and `threads.rollback` takes `beforeTurnId`,
  resolved while the thread is held. Before rewinding, the images must fit
  beside what the composer holds (T3's "Make room for this message's
  attachments in the composer before rewinding."); after it the message is
  never lost: it goes to the thread's composer if it is on screen, else to
  the thread's stored draft. Without a dialog to ask, nothing is rewound
  unless the call says `confirmed`. The client command is
  `thread.edit-from-here` (`{ node, remote?, threadId, turnId, confirmed?
  }`); the hover rows are the slot `chat.message.actions` (props
  `ChatMessageActionProps`), so the copy button, this one and D224's are
  contributions.
- **D224. Regenerating = dropping a turn and sending its message again.**
  `threads.regenerate` (`{ threadId, turnId? }`, the latest turn by
  default) rolls back to before the turn and starts a turn with its text,
  images, agent (the thread's when that agent is gone from the node), the
  model it named (else the thread's) and modes, as one command: nothing can
  start in between, and the drop is the last step before the turn starts,
  so only a turn whose first event cannot be written leaves the turns
  dropped without a new one. A turn whose start recorded no message to
  send again is refused (`TURN_NOT_FOUND`), as is one whose message is
  empty (`MESSAGE_EMPTY`), before anything is dropped. The timeline's "Retry" of a failed latest turn
  runs it (it sent the message again before, leaving the failed turn
  above); a stopped turn keeps its "Run interrupted" divider without a
  retry, as before (T3's "Resume thread" is Deferred), and the latest final
  answer gets "Regenerate response" (`RefreshCwIcon`) in its hover row;
  client command `thread.regenerate`.
- **D225. Forking at a turn.** `threads.fork` (`{ threadId, turnId?, title?
  }`, the latest ended turn by default) creates a thread in the same project
  with the parent's agent, model and modes, titled "<title> fork" (T3's),
  whose record says `forkedFrom: { threadId, turnId }` (T3's lineage). Its
  stream copies the visible events of the turns up to `turnId`, each payload
  with `inheritedAt` (the original time, so durations and timestamps stay;
  a fork of a fork keeps the first parent's),
  then `threads.thread.forked` (`{ threadId, turnId }`), where the timeline
  draws T3's divider "Forked from conversation" with "Open source
  conversation".
  Copying, not referencing the parent as T3's projection does, keeps a fork
  readable when its parent is deleted or lives on a node that is away. The
  copy is one read of the parent's log, a consistent state of it; a fork's
  own turns are those without `inheritedAt`, so they stay apart from the
  copied ones even once the fork point is rolled back in the fork. The
  turn forked at cannot be running or waiting (`TURN_IN_PROGRESS`, T3's
  "in-progress runs cannot be forked"); an earlier ended turn can be forked
  while a later one runs, and the copy stops at it. The agent's own session is not copied: Claude
  starts the fork's session with the transcript (D222); T3's native session
  fork is deferred. The latest-turn final answer and every ended turn's
  final answer get "Fork from this response" (`GitForkIcon`); client
  command `thread.fork` opens the fork.
- **D226. Merging a fork back.** `threads.merge-back` (`{ threadId, turnId?
  }`: the fork, and its latest ended turn by default) records on the parent
  `pendingMergeBack: { id, threadId, turnId, at }`, replacing an older one
  (T3's superseded transfer; it is the user's arrangement, so `updatedAt`
  stays); no turn starts. The parent's next turn gives the
  agent T3's handoff before the user's text: "Context handoff (merge_back /
  fork_delta_summary):", "Merge-back context from forked conversation.", the
  source and target threads, then every user message and answer of the fork
  after the fork point up to that turn ("- User: …", "- Assistant: …", each
  compacted and cut at 240 characters), then "User message:" and the text.
  The turn's event keeps the user's text as typed and the handoff apart
  (`handoff: { kind: "merge-back", threadId, turnId }`), where the timeline
  draws a divider "Merged back from fork" with the fork's title and "Open
  fork"; the mark goes once that turn has started, so a turn that cannot
  start leaves it for the next message. A mark whose fork, or whose merged
  turn, is gone since is dropped and the message goes alone; one whose fork
  cannot be read now stays. Dropping a turn that delivered a merge (a
  rollback, "Edit from here") gives the mark back, and regenerating it
  merges into the new turn again. Refused for a
  thread that is not a fork (`THREAD_NOT_FORK`), a parent that is gone
  (`THREAD_NOT_FOUND`), a fork turn the parent already got (`NOTHING_TO_MERGE`: its handoff
  would say it twice), an archived parent (`THREAD_ARCHIVED`: it takes no
  message to deliver the merge with) or a fork with no ended turn of its own
  (`TURN_NOT_FOUND`). The fork's header gets T3's `GitMergeIcon` button
  "Merge back to <parent>" ("Merge this conversation back into <parent>";
  disabled: "Complete a run in this fork before merging it back") in
  `chat.header.actions`, which opens the parent; client command
  `thread.merge-back`.
- **D227. Searching thread contents on the node.** `threads.search`
  (`{ query, limit?, projectId? }`: 2–200 characters, at most 50 results,
  50 by default) matches the visible user messages and completed answers of
  every thread that is not archived, ignoring ASCII case (T3's SQLite
  `LIKE`; this plan first said case- and accent-insensitive, T3 is not
  accent-insensitive) and comparing whitespace collapsed, as the snippet shows it, so
  "foo bar" finds "foo↵bar", one match per thread (its newest user message, else its newest
  answer), user matches first, then by the thread's `updatedAt`; a match is
  `{ threadId, projectId, source: "user" | "assistant", snippet, at,
  updatedAt }` with
  T3's snippet (whitespace collapsed; past 240 characters a window of 236
  from 72 before the match, "…" at cut ends). The node keeps each thread's
  texts in memory by stream head and reads only what came since; a rollback
  among the new events drops its turns' texts. A search reads eight threads
  at a time, and searches at once share a thread's read. The texts held are capped at
  32 million characters, the least recently searched threads going first
  (the thread just read stays, even alone past the cap),
  and a deleted or archived thread's go at once (also when it goes while
  they are read).
- **D228. The palette and the sidebar search contents too.** While a query
  has two characters or more, the sidebar's search asks every shown node
  (and mesh member) after a pause of 200 ms; title matches come first, then
  threads matched by content, each with its snippet ("You:" or "Agent:",
  the query marked), "Searching thread messages…" while asking and "No
  threads found" when nothing matches (T3's SidebarThreadHeader). The
  palette adds each match's snippet to its thread's search terms, so a
  thread found by content ranks after title matches, and says "Searching
  thread messages…" while asking (T3's buildThreadActionItems). Across
  nodes the matches keep D227's order (user matches first, then by the
  thread's `updatedAt`). A node that has not answered after 10 seconds counts
  as having failed until its answer comes, so a hung relay never leaves a
  view waiting; a node that
  failed, unlike one older than `threads.search`, makes the empty sidebar
  say "No threads found. Some nodes could not search their messages.", and
  the palette ranks a thread by a snippet of the query typed now only; a view
  says it is searching from the moment two characters are typed, before its
  request goes out. Both searches cover every thread the sidebar lists,
  collapsed shelves included.

W2 lands as a stack of pull requests: the rollback first (D220–D222, which
W3 builds on), then editing and regenerating (D223, D224), forks and merging
back (D225, D226), and search (D227, D228).

D227 and D228 were refined in review before they shipped: ASCII case
folding instead of accents, `updatedAt` in a match, the 10 s deadline and
the failure label, the cache's bound and shared reads.

The proof of D223–D228: `plugins/threads/test/history.test.ts`
(regenerating the latest or an earlier turn with its settings, refusals;
forking with times kept and the fork's history, refusals; merging back with
T3's handoff text delivered once, refusals; searching with T3's order and
snippets, archived threads, projects, rollbacks and new turns);
`apps/web/test/history.test.ts` (the message back in the composer, the
turns a thread shows); `apps/web/test/timeline.test.ts` (inherited times,
the fork point, handoffs); `apps/web/test/thread-search.test.ts` (the pause,
two characters, every node, the newest query only, nodes that cannot
search, highlighting); Playwright `e2e/tests/history.spec.ts` (Edit from
here and cancelling it, Retry and Regenerate response, forking and merging
back, finding threads by their messages in the sidebar and the palette),
with screenshots.

The proof of D220–D222: `plugins/threads/test/history.test.ts` (dropping the
turns after a turn or every turn, the log kept and the agents' history
without them, the record's last turn, nothing to drop, the refusals, the
thread held while it rolls back, the hook wrapping and refusing it);
`plugins/agent-claude/test/session.test.ts` (a session holding a dropped turn
replaced by a new one with the transcript, its process ended, the next turn
staying on it, records older than rollbacks resumed by the thread's id);
`apps/web/test/timeline.test.ts` (dropped turns leave the timeline, at once
and as events arrive).

### Steering and history leftovers (W19)

W19 of `t3-roadmap.md` (round 2) takes what W1 and W2 left in Deferred.
Reference: T3 Code at `eb7b35ac` (D53).

- **D800. "Resume thread" for a stopped turn**, as T3's composer
  (`ComposerPrimaryActions.tsx`, `ChatView.tsx` `onResume`). When the
  thread's latest turn was interrupted, or its queue is held with messages
  waiting (D202), and the composer is empty, the send button becomes "Resume
  thread" with T3's play icon. Pressing it sends T3's "Continue where you
  left off." as the next turn (`threads.send` with the composer's agent,
  model and modes; it shows as the user's message, as in T3), then lets a
  held queue go on (`threads.queue.resume`), so the queued messages follow
  the continued turn. With nothing interrupted it only resumes the queue. A
  failure says which step failed ("Could not resume thread: …", or "The
  thread resumed, but its queue did not: …") under the timeline. The message
  goes only to a free thread (`threads.send`, never queued), so pressing
  again never sends it twice. The
  client command `chat.thread.resume` ("Resume thread") does the same for
  the open thread. T3 also resumes a turn that failed on a usage limit; Jhin
  has no usage-limit failures yet (Deferred).
- **D801. Find in a thread**, T3's `chat.find` (`ThreadFindBar.tsx`,
  `threadFindHighlights.ts`). The client command `chat.find` ("Find in
  thread") opens a find bar over the open thread's messages; `mod+f` runs it
  while a thread is open and focus is not in a terminal or the right panel
  (`threadOpen && !terminalFocus && !previewFocus`), so elsewhere the
  browser's own find stays. The bar is T3's: a "Find in thread" search
  field, the count ("2/5", "0/0" in red when nothing matches), "Previous
  match", "Next match" and "Close find"; Enter goes to the next match,
  Shift+Enter to the previous, Escape closes the bar (closing hands focus
  back to the composer), and each `mod+f` focuses the field and selects its
  text again. Matching folds case as T3 does, counts a run of white space as
  one space outside `<pre>` (as the browser shows it), never spans two
  blocks and passes over buttons, icons and what is hidden from assistive
  technology, which also break a run of text. The highlights and
  `chat.find` belong to the one thread view on screen. Matches are painted with the CSS Custom Highlight API in T3's
  colours (the current one darker) and found again as the thread's text
  changes; the current match scrolls into view. T3 searches on its server,
  because its timeline is virtualized and pages its history; Jhin's
  timeline renders every turn, so the find runs over the page's text and
  adds no node command. Another thread opens with the bar closed. Text
  inside a finished turn's folded work is not rendered until it is
  unfolded, so it is not found (T3 opens the fold holding the current
  match; Deferred).
- **D805. Claude's foreground subagents go to the background before a
  steer**, as T3's `ClaudeAdapterV2.ts` (`backgroundForegroundSubagents`
  before `steerTurn`). A steer reaches Claude Code with priority "now",
  which cancels the running tool calls of the turn; a subagent the turn
  launched in the foreground (an `Agent` or `Task` tool call of the main
  conversation without `run_in_background`) is one of them. So the turn
  keeps the tool calls of its subagents that have not returned, and before
  it hands Claude Code a steer it asks the SDK to move each to the
  background (`Query.backgroundTasks(toolUseId)`, Claude Code's Ctrl+B): the
  subagent keeps running and its result comes later as a background task's
  notification. Each tool call is asked once; a later steer waits on the
  same answer. Claude Code may never answer, so the steer goes in after 5 s
  regardless (T3's timeout), and a move left unanswered then holds no later
  steer, and a refusal (background tasks disabled) is
  logged and the steer goes in as before. Background Bash commands are left
  alone, as in T3. A CLI without the control (`backgroundTasks` missing) gets
  the steer as before. When the subagent ends after its turn, Claude Code
  reads its result in the next turn of the live session; T3's wake of an
  idle thread for it (its continuation turns) stays Deferred.
- **D803. T3's restart dispatch for agents that cannot steer**
  (`CommandPolicy.ts` `decideSteeringExecution`: `interrupt_restart` when a
  provider cannot steer actively). `threads.steer` and `threads.queue.steer`
  no longer refuse an agent without `steering` (`STEER_UNSUPPORTED` stays a
  known code, no longer sent): the message goes first in the thread's queue,
  the running turn stops, and once its end is recorded the message starts
  the next turn at once. That stop holds no queue (D202), and the message
  starts past a hold already there, which stays for the rest; so what was
  queued follows the restarted turn. `threads.steer` answers `started` with
  the new turn's id (`queued` if it could not start yet); `threads.queue.steer`
  answers the new turn's id. A turn that ends or is being stopped meanwhile
  is treated as before (the message is queued first). T3 restarts the run
  as a new attempt of the same run; Jhin records the stopped turn and a new
  turn with the message, so the timeline shows the stop. The client offers
  steering for every running turn, as T3's composer does for a provider that
  steers either way, and the "Queued instead" notice says only that the
  turn ended first.
- **D804. Steering a turn that waits for an approval or an answer stays as
  it is, which is T3's behaviour.** T3 steers a run while one of its
  requests is pending (`dispatchSteerIntoRun` checks only that the run is
  `running`; its run status `waiting` is the drain after the agent's turn),
  and the provider takes the message once it goes on. T3's composer, like
  Jhin's (D209), sends nothing while an approval is open, and its typed text
  answers an open question. So a steer from the queue banner or a command
  reaches the agent after the approval or answer, as in T3.

### Composer leftovers (W23, `t3-roadmap.md`)

The parts of T3's composer that W6 left in Deferred (D303, D291–D296), at
T3 Code `eb7b35ac` as D290 says.

- **D841. Code blocks in the prompt are highlighted with Shiki,** as T3's
  `composerCodeBlockHighlight.ts`: inline decorations over the block's text,
  tokenized in both themes at once (`--shiki-light` / `--shiki-dark`, the way
  the messages' blocks are), so a theme change repaints without tokenizing
  again. A block is tokenized again only when its language or text changes; a
  block past 20 000 characters stays plain, as in T3, because each keystroke
  tokenizes the whole block. The grammars are the messages' own
  (`lib/highlight.ts`), so the composer loads no grammar the thread would
  not. While an edited block is tokenized again it keeps its previous
  colours, mapped through the edit, so typing does not flash it plain.
- **D842. T3's language picker** in a code block's header: a combobox named
  "Code language: <label>" with "Search languages" and "No matching
  languages.", the list and aliases of T3's `composer-code-languages.ts`
  ("Plain text" first; here `apps/web/src/lib/code-languages.ts`), a language the list lacks shown first under its own name.
  The pick rewrites only the first word of the fence's info string, so
  `ts title=x` keeps `title=x`; plain text clears it, or writes `text` when
  something follows. The search matches a language's label and id, as T3's; the aliases only
  name an existing fence (`ts` shows as TypeScript). The caret returns to the
  block's end. The prompt's
  markdown is the only state, so drafts and the queue keep the language.
- **D843. Tab indents in a code block,** as T3's `indentCodeBlock`: with no
  selection Tab inserts two spaces; with one it indents every line the
  selection touches, and Shift+Tab takes back two spaces, a tab or a space
  from each. Inside a block Tab never leaves the editor, as in T3, so the
  keyboard way out is to move the caret below the block. Outside code blocks
  Tab keeps its list nesting (D303) and otherwise leaves the editor.
- **D844. Typing a bracket or quote over a selection wraps it,** as T3's
  `handleTextInput` with `SURROUND_CLOSE`: `(`, `[`, `{`, `'`, `"`, `“`,
  `` ` ``, `<`, `«`, `*` and `_` put their closer after the selection and
  keep the text selected inside. As in T3 it never wraps a chip, styled text
  (the plain replace keeps its marks) or the space that bounds a chip, and an
  input method's composition is left alone.
- **D845. T3's "Show skills in slash menu"** setting (General, on by
  default): "Also include skills in the / command menu. Skills always appear
  when you type $." Off, the `/` menu lists no skills, and a provider command
  that shares a skill's name shows again, as T3's
  `getProviderSkillsForSlashMenu` and `getProviderSlashCommandsForSlashMenu`. It is `showSkillsInSlashMenu` in
  the client's `jhin.chat` section.

### Sidebar leftovers (W26)

W26 of `t3-roadmap.md` (round 2) takes what W14 left in Deferred.

- **D962. The selection menu's "Custom…" snooze, as T3's.** The "Snooze
  (N)" submenu ends with a separator and "Custom…", which asks in the same
  "Custom snooze" dialog as a single thread and snoozes every selected
  thread until the time chosen. The dialog is `jhin.thread-actions`', and
  asking is a command of its own, `thread.snooze.choose` (output `{ until? }`,
  nothing when cancelled), so the sidebar asks through it.
  `sidebar.selection.snooze`'s `until` becomes optional: without it, the
  command asks first and does nothing when cancelled.

## Not ported (out of scope)

- T3 accounts, sign-in, billing, hosted environments, and pairing and
  remote access through a T3 account (T3 Connect). Pairing a device with a
  node without T3 is planned (`t3-roadmap.md`, W13), and so is the desktop
  app with its window chrome, native menus and auto update (W18).
- T3's provider settings (API keys, CLI paths): they belong to the agent
  plugins that need them.

## Deferred

- Applying Fast Mode and Ultracode to a live Claude Code session through
  `applyFlagSettings` (T3 does): a change of them starts it again (D298).
- The editor's parts T3 has and this port left out (D303): the file icons
  of the code-block language picker (D842; with the chips' file icons), a
  keyboard way out of a code block other than moving the caret (D843; T3 has
  none), headings,
  horizontal rules and task lists (kept as text), visible marks at the caret,
  citation and context-reference chips, chip popovers (file icons, a skill's
  description and "View instructions"), `#` pull-request mentions and other
  threads in the `@` menu, the
  plain-text and literal modes, `aria-activedescendant` from the editor to the
  menu.
- Attachments (D291–D296): the node finds a thread's attachments by listing
  every attachment's record when the thread is deleted (fine for thousands,
  not for millions); T3's preview of a file in the composer and in the
  message (here a file downloads), video attachments, and T3's captured
  window context on screenshots. A live Claude Code session starts again
  when a turn's attachments add their folder to `additionalDirectories`.
- Thread history (W2, D220–D228): Claude Code's native rewind and fork (`resumeSessionAt` and
  `forkSession` instead of a new session with the transcript, D222, D225;
  until then a Claude session record that could not be written, or one
  from before D222, lets the next turn resume a session that still holds
  the dropped turns, D222; and the Claude Code session a new one replaces is
  left on disk),
  a budget for a merge-back's handoff (each line is cut at 240 characters,
  but a long fork gives many lines; T3's summary text is unbounded too),
  a merge-back's handoff in an agent's history (it reaches the agent as the
  text of the turn that delivers it, and the stored event keeps the user's
  text, so a runtime replaying history, as Claude's transcript does for a new
  session, sees only the user's text), a search index on disk (the node reads
  each thread's texts once per run and one thread after another on the first
  search, D227), searching again while a query stays typed (T3 asks again
  after 30 s; here the next change of the query or of the nodes does) and
  T3's Lineage panel listing a
  thread's forks.
- Sidebar (T3's layout, D70, D75–D79): T3's "Keep threads with a PR"
  (`sidebarAutoSettleKeepPullRequests`) and its rule that an open pull
  request linked to a thread keeps it from settling by inactivity: the
  threads plugin does not know a thread's pull request (linking them is
  W4's); per-project overrides of the settle settings (T3 resolves them per
  project; a Jhin node has one project config layer, D19);
  the selection menu's "Regenerate titles (N)" (no title
  regeneration yet); dragging a selection into the
  chat as context; the undo of an unpin or a settle done by dragging (a
  drop writes through `threads.arrange`, not the commands that offer an
  undo, D450); T3's X on a thread's card that clears its unsent composer
  text (the sidebar does not know a thread's draft, which the chat plugin
  keeps). The card's branch, diff and pull request are `source-control.md`'s
  D117 and its terminal indicator `terminal.md`'s D148, all in the
  `sidebar.thread.indicators` slot.
- Pushing a mesh member's config changes to a client of another node: done
  for connections in `config-ui.md` D483–D484; a member's `host/config` is
  not followed through the mesh yet (`config-ui.md#deferred`).
- Drafts are per device; syncing them, and device settings, across devices
  (`config-ui.md` D486–D488). Visits are shared through the thread's node
  since `config-ui.md` D485.

- "Resume thread" (D800) for a turn that failed on a usage limit, as T3
  offers: Jhin has no usage-limit failures to tell apart yet.
- Find in a thread (D801): matches inside a finished turn's folded work,
  which T3 finds and opens the fold for; here they are found once the fold
  is open.
  While the bar is open, each change of the thread's text (every streamed
  token, once a frame) walks the whole thread again; finding again only in
  the turns that changed would keep a long streaming thread cheap. And white
  space counts as one space everywhere but `<pre>`, also in text shown with
  `white-space: pre-wrap` (reading the computed style would match it).
- A steer Claude Code's turn ended before it took, while its subagents were
  being moved to the background (D805): the threads plugin recorded it as
  steered, and the runtime only logs it (T3 fails the steer and starts the
  follow-up turn; `AgentTurn.steer` is synchronous, D204).
- T3's restart as a new attempt of the same run (D803): here the stopped
  turn and the restarted one are two turns in the timeline.
- Steering a Claude Code that does not mark its frames (an older CLI): its
  first result after a steer ends the turn, so a steer it took only after
  answering loses its answer. And one that sends no idle reports: a result
  passed over for a steer that it never answers leaves the turn waiting until
  Claude Code exits, and the turn then fails ("ended without a result").
- A slow `threads.title` hook holds the queue: `threads.queue.add` on a
  free thread with nothing queued starts its turn under the queue's lock,
  and a thread's first message runs the hook. Edits of that thread's queue
  wait for it.
- Thumbnails of queued images: `threads.queue.updated` carries their names
  and types only (the data stays in the queue's record), so a queued row shows
  text, not T3's thumbnails, until attachments are blobs (W6).
- A browser component test of the composer's queue banner (the `mod-enter`
  send shortcut with something queued, the "Retry" label of a refused
  message): the e2e spec covers the flows with the default shortcut only.
- A steered message whose removal from the queue could not be written, twice
  (the steer's write and its retry), is kept from running again only in
  memory: a node restarted before it would start sends it once more.
- `threads.queue.steer` into a turn that is ending answers `TURN_NOT_RUNNING`,
  as for an idle thread; a code of its own (or queueing it first, as
  `threads.steer` does) would let a client tell the two apart.
- The client commands `chat.queue.steer-next`, `chat.queue.edit-latest` and
  `chat.composer.send-alternate` succeed when there is nothing to steer, edit
  or send (from the palette or MCP); they could say so.
- Idempotent sends: `threads.queue.add` ignores a `messageId` already queued,
  but a message that already left the queue (started or cancelled) is taken
  again; `threads.send` takes no id. So a client that retries a send whose
  answer was lost can run it twice; the web client retries only after a
  definite refusal (`TURN_IN_PROGRESS`, `STEER_UNSUPPORTED`), when nothing ran.

Done since in `t3-roadmap.md`'s W1 (D200–D211): the server-side queue and
steering, idempotent thread creation and one write for a record and its
index event. W2 (D220–D228): editing a sent message, regenerating, forking
and searching thread contents. Elsewhere: the Codex and OpenCode runtimes
(`providers.md`, W7, W8); checkpoints, reverting a thread's files with a
rollback, worktrees, git actions and linked pull requests
(`source-control.md`, W3, W4); scoped tokens and secret config values
(`security.md`, D410–D417).

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
