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
  `plan`) and image attachments. Besides message deltas a turn yields
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
  get it, and an answer that could not be recorded can be sent again.
- **D57. The thread record says where its latest turn is** (`lastTurn`:
  running, waiting, completed, interrupted, failed, with its time) and when it
  changed (`updatedAt`, `archivedAt`). Every change appends
  `threads.thread.updated` to the `threads` index, so a client follows a
  node's whole catalog from one stream: `threads.catalog` returns projects,
  threads and the index head they reflect. After a restart, turns that were
  running are recorded as interrupted.
- **D58. Thread and project management as commands:** rename, archive and
  unarchive, delete (the stream keeps a final deleted event); a new thread
  takes its title from its first message (hook `threads.title`); projects can
  be created (the name defaults to the folder's), renamed and deleted (never
  the scratch project; its threads go with it); `projects.browse` lists
  folders for the project picker, under a permission of its own
  (`projects.browse`), since it reads any folder the node can.
- **D68. One turn per thread, and none on a thread going away.** Checking
  that a thread is free and reserving it is one step, so concurrent sends
  start one turn. An archived thread takes no messages until it is unarchived
  (`THREAD_ARCHIVED`); no turn starts on a thread while it is being archived
  or deleted, so nothing is written after its deleted event, and no thread is
  created in a project being removed. Archiving and deleting stop a running
  turn; an agent that ignores the interrupt for `STOP_TIMEOUT_MS` (5 s) is
  given up on: its turn is recorded as interrupted and the thread freed.

### Client

- **D59. New client capabilities**, each provided by a builtin plugin and
  replaceable: `client.threads@1` (the catalogs of every node and mesh member
  the client reaches, kept current from their indexes), `client.settings@1`
  (the device config layer), `ui.keybindings@1`, `ui.toasts@1`,
  `ui.dialogs@1` and `ui.settings@1` (settings sections are contributions).
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
  the last visit), relative times, inline rename, archive on hover and a
  context menu (rename, mark unread, copy id, copy `jhin://` address, archive,
  delete). Visits are kept per device and compared with the node's own times.
- **D65. Chat view:** T3's timeline — user bubbles, markdown answers
  (GFM, Shiki highlighting in both themes), a work log per turn with a
  summary that folds behind "Worked for …" once the turn ends, plan cards,
  failed and interrupted turns with their reason and a retry. The composer has
  the model picker, access mode, plan/build toggle, image attachments, a
  context meter from token usage, prompt history (↑/↓), drafts per thread,
  approval and question banners, and a queue of follow-ups sent while a turn
  runs (client side, see Deferred). An archived thread shows a way to
  unarchive it instead of the composer. The header has a breadcrumb, title actions
  and the slot `chat.header.actions` (props: `ChatHeaderActionProps`).
- **D66. Settings page** with sections as contributions: General, Appearance
  (system/light/dark, chat width), Notifications, Keybindings (record, reset,
  search), Nodes (connections, agents, mesh members), Node config (edit any
  section of the node layer with its JSON Schema; save to several nodes
  through the mesh scope picker, D20, with pending targets, D50) and
  Archived threads.
- **D67. Notifications** when a thread completes, fails, or waits for
  approval or input: with the page in focus, an in-app toast (never for the
  open thread); otherwise a browser notification and/or a sound, as the
  device setting says, and the tab title counts the notifications not yet
  seen.

## Not ported (out of scope)

- T3 accounts, sign-in, billing, hosted pairing and hosted environments.
- Desktop-only features: window chrome, auto update, native menus.
- T3's provider settings (API keys, CLI paths): they belong to the agent
  plugins that need them.

## Deferred

- Real agent adapters (Claude Code, Codex, OpenCode): the API (D54) and UI
  are ready; only the fake agent implements them.
- A server-side message queue and steering: follow-ups wait in the client
  while a turn runs and are lost if the page closes.
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
- Code splitting of the web client: the main chunk is over 500 kB minified.
- Scoped tokens: `projects.browse` has a permission of its own, but every
  token today holds every permission (`*`), so whoever holds a node's token
  can list the names of folders the node process can read. Grant it on
  purpose once tokens carry scopes.

Done here from the foundation's Deferred list: the settings UI with the scope
picker (D66) and "No project" chats in the UI (D64).

## Landing

One PR. Its parts depend on each other: the threads plugin names threads
after their first message and reports requests, which the previous web client
did not expect, and the new client needs the new commands. The proof:

- `plugins/threads` tests: management, titles, projects, agents, tool,
  reasoning and plan items, approvals, questions, interrupts closing requests,
  restart recovery, attachments; concurrent sends, archives, deletions and
  project removals, answers of the wrong kind or not recorded, agents that
  ignore an interrupt (D68); kernel and MCP tests of command titles; the
  node-host test of `host.config.get` and `host.config.schema`.
- `apps/web/test`: keybindings, timeline, palette search, prompt history and
  drafts, status pills and visits, routes, the threads store, notifications.
- Playwright: send and stream, stop, approval, questions, archiving, the
  palette, the inspector, mesh and client plugins, with screenshots in the
  report.
