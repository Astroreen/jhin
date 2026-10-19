# T3 Code parity plan

Status: **implemented**. This file records the decisions taken while
bringing T3 Code's design and features into Jhin's plugin system, what was
left out on purpose, and what is deferred.

## Goal

Make the web client look and behave like T3 Code, and give the agent API what
that UI needs, without giving up a rule of `AGENTS.md`: everything is a plugin
on the public API, every operation is a command, UI is slots and
contributions. Features of T3 Code that only make sense for its hosted product
(accounts, billing, hosted pairing, desktop updates) are out of scope.

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
  settles as of its last activity. The header holds the search (results
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
  The icon is T3's "server" machine kind for every node: nodes have no kind
  to pick yet (Deferred). The agent's icon is Claude's for
  `jhin.agent-claude` and a generic one for any other runtime.
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
  (and remote member), as `project.add` does (additive). Disconnecting from
  that menu leaves the settings page open.
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

The proof: `apps/web/test/sidebar-order.test.ts` (statuses, Done after a
visit, fading, the settle rule, one list across nodes in T3's order, the
project filter, the Settled shelf's paging and collapsed state, search) and
`apps/web/test/nodes.test.ts` (which nodes are shown, node names only with
several, the store following and releasing meshes and catalogs); Playwright
`e2e/tests/sidebar.spec.ts` (no node icon with one node, icons with two, the
project filter keeping two "web" projects apart, search, settings leading the
footer, the node picker, the node menu in settings, the rename dialog's
footer inside its panel, and threads settling with the client's clock four
days on) and the web and mesh specs, which use the cards and their context
menu.

## Not ported (out of scope)

- T3 accounts, sign-in, billing, hosted pairing and hosted environments.
- Desktop-only features: window chrome, auto update, native menus.
- T3's provider settings (API keys, CLI paths): they belong to the agent
  plugins that need them.

## Deferred

- Real agent adapters for Codex and OpenCode. Claude Code is done
  (`docs/plans/providers.md`).
- A server-side message queue and steering: follow-ups wait in the client
  while a turn runs, go out only while the page is open, and are lost if it
  closes.
- Terminal drawer (`node-pty` + xterm) and the `terminalFocus` context key.
- Git and source control: branch toolbar, diff panel, checkpoints and
  reverting to a turn, worktrees, pull requests.
- Composer: `@` file mentions, slash commands, rich text (tiptap), pasted
  files other than images, image compression and HEIC conversion.
- Implementing a proposed plan from plan mode with one action.
- Editing a sent message, regenerating, forking a thread.
- Searching thread contents (the palette and the sidebar search titles).
- Sidebar (T3's layout, D70): settling and un-settling by hand, settling on a
  merged pull request, and the time a thread came back from the shelf: they
  need settlement kept on the node, so a thread settles only by itself
  today and a revived one keeps its place by creation; pinning and its
  section, snoozing and the Snoozed and Working shelves, drag-and-drop
  ordering, multi-select, the jump-number hints, discarding a draft from its
  card, and the card's branch, diff, terminal and pull request indicators
  (source control and terminals are deferred above).
- A machine kind per node (T3's environment icon picker), so the node icons
  of D71 differ by machine; every node shows the "server" icon today.
- Visits and drafts are per device; syncing them, and device settings, across
  devices.
- Warnings for conflicting keybindings in the settings page.
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
- Scoped tokens: `projects.browse` has a permission of its own, but every
  token today holds every permission (`*`), so whoever holds a node's token
  can list the names of folders the node process can read. Mesh members call
  each other with every permission too. Grant it on purpose once tokens carry
  scopes, and give mesh calls a scope of their own. The same goes for
  `host.config.read` (D66): `host.config.get` returns the node's and project's
  config files as written, so it reads any secret a section keeps there.
- Secret config values: no first-party section holds one today. A section
  that does needs a way to mark those values, so that `host.config.get`
  redacts them and the editor keeps them when it saves, before
  `host.config.read` can go to a caller that may not see them. The marker
  exists now (`writeOnly`, `config-ui.md` D83) and the form masks such
  values; the redaction is still to do.

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
