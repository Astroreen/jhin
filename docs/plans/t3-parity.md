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
  requests without a response, so a client never shows a stale question.
  While a request is open the thread's last turn is `waiting` with
  `waitingFor` (`approval` or `user-input`). An answer must be of the
  request's kind, and it counts once it is recorded: only then does the agent
  get it, and an answer that could not be recorded can be sent again. An
  answer to a turn that is ending is refused (`REQUEST_NOT_FOUND`), never
  reported as delivered.
- **D57. The thread record says where its latest turn is** (`lastTurn`:
  running, waiting, completed, interrupted, failed, with its time) and when it
  changed (`updatedAt`, `archivedAt`). Every change appends
  `threads.thread.updated` to the `threads` index, so a client follows a
  node's whole catalog from one stream: `threads.catalog` returns projects,
  threads and the index head they reflect. After a restart, turns that were
  running are recorded as interrupted, and their open requests closed.
- **D58. Thread and project management as commands:** rename, archive and
  unarchive, delete (the stream keeps a final deleted event); a new thread
  takes its title from its first message (hook `threads.title`); projects can
  be created (the name defaults to the folder's), renamed and deleted (never
  the scratch project; its threads go with it); `projects.browse` lists
  folders for the project picker (links to folders too, without blocking the
  node on a slow disk), under a permission of its own (`projects.browse`),
  since it reads any folder the node can. Paths may start with `~` or `~/`
  for the home directory; `~user` is not expanded.
- **D68. One turn per thread, and none on a thread going away.** Checking
  that a thread is free and reserving it is one step, so concurrent sends
  start one turn. An archived thread takes no messages until it is unarchived
  (`THREAD_ARCHIVED`); no turn starts on a thread while it is being archived
  or deleted, so nothing is written after its deleted event, and no thread is
  created in a project being removed. Archiving and deleting stop a running
  turn; an agent that ignores the interrupt for `STOP_TIMEOUT_MS` (5 s) is
  given up on: its turn is recorded as interrupted and the thread freed, and
  the node stops waiting for the agent's next item and closes its items, so
  an agent that never answers again holds nothing. A turn still starting at
  that deadline is given up on as soon as it has started; a request is always
  recorded opened before its turn's end closes it. Two
  deletions of one thread at once delete it once. A deletion that fails
  before the thread's stream records it leaves the thread as it was; one
  that fails later keeps it closed, and deleting it again finishes the job.
  Two removals of one project at once remove it once; a removal waits for
  threads being created in the project, so none is left behind; a project
  whose removal fails takes new threads again. An answer the agent fails to
  take stays recorded (`AGENT_FAILED`), and the request takes no second one.

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

- **D64. Sidebar:** T3's per-project thread tree, under one section per node
  (each connection and each reachable mesh member, D47). Rows show status
  pills (pending approval, awaiting input, working, failed, completed since
  the last visit), relative times, inline rename, archive on hover, a filter
  and "Show more" per project, and context menus (D69). Visits are kept per
  device and compared with the node's own times.
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
  (`ProjectActionProps`) and `node.actions` (`NodeActionProps`): the sidebar
  and the header render the slots, so a plugin adds an item, a shortcut or a
  palette entry the same way the builtins do. Saved connections, drafts and
  visits follow the other tabs of the same browser.

## Not ported (out of scope)

- T3 accounts, sign-in, billing, hosted pairing and hosted environments.
- Desktop-only features: window chrome, auto update, native menus.
- T3's provider settings (API keys, CLI paths): they belong to the agent
  plugins that need them.

## Deferred

- Real agent adapters (Claude Code, Codex, OpenCode): the API (D54) and UI
  are ready; only the fake agent implements them.
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
- Searching thread contents (the palette searches titles).
- Sidebar: drag-and-drop ordering, pinning, snoozing, sort options, T3's
  newer sidebar layout.
- Visits and drafts are per device; syncing them, and device settings, across
  devices.
- Warnings for conflicting keybindings in the settings page.
- Idempotent thread creation (an id chosen by the client): a
  `threads.create` whose answer the connection dropped can leave an empty
  thread behind.
- Attachments as blobs: images travel as data URLs inside the turn's first
  event, hence the 20 MB per message (D54).
- Code splitting of the web client: the main chunk is over 500 kB minified.
- Scoped tokens: `projects.browse` has a permission of its own, but every
  token today holds every permission (`*`), so whoever holds a node's token
  can list the names of folders the node process can read. Grant it on
  purpose once tokens carry scopes. The same goes for `host.config.read`
  (D66): `host.config.get` returns the node's and project's config files as
  written, so it reads any secret a section keeps there.
- Secret config values: no first-party section holds one today. A section
  that does needs a way to mark those values, so that `host.config.get`
  redacts them and the editor keeps them when it saves, before
  `host.config.read` can go to a caller that may not see them.

Done here from the foundation's Deferred list: the settings UI with the scope
picker (D66) and "No project" chats in the UI (D64).

## Landing

One PR. Its parts depend on each other: the threads plugin names threads
after their first message and reports requests, which the previous web client
did not expect, and the new client needs the new commands. It also fixes a
defect of the dev scripts found while proving it with `scripts/t3/smoke.sh`:
`stop.sh` gave up 2 s after it started instead of 2 s after its first
SIGKILL, so on a slow machine it reported processes it had just killed.

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
