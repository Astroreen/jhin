# Glossary

One word per concept. Use these terms in code, docs, commits and UI.

Words about the docs themselves (`docs/README.md`):

- **Context library** — everything Jhin knows about itself in `docs/`, plus
  `AGENTS.md` and this file, with routes between them.
- **Trailhead** — where an agent starts: `AGENTS.md`. It points to the
  answers instead of holding them.
- **Map** — `docs/map.md`: everything that exists, one line each, with the
  route to its details.
- **Route** — a link that makes a piece of knowledge reachable from the
  trailhead. Knowledge without a route does not exist for an agent.
- **Canon** — knowledge the project relies on: `AGENTS.md`, this file,
  implemented plans, the map. Below it, in falling trust: insight, note,
  observation, exhaust.
- **Lore** — `docs/lore/`: named stories of recurring failures ("moonbase"),
  told instead of adding one more rule.

Words about Jhin:

- **Kernel** — the small isomorphic core (`@jhin/kernel`): loader, lifecycle,
  dependency graph, service registry, hooks, commands, config, events,
  disposables, scoped state. Contains nothing product-shaped.
- **Plugin** — an npm package with a `"jhin"` manifest in `package.json` and
  an entry exporting `definePlugin(...)`. Everything the user sees or runs is a
  plugin.
- **Manifest** — the `"jhin"` field: `id`, `version`, `apiVersion`, `side`,
  `provides`, `requires`, `entry`. Validated before any plugin code runs.
- **Side** — where a plugin runs: `server`, `client` or `both`.
- **Capability** — a versioned interface id such as `storage.eventlog@1`.
  Plugins provide and require capabilities, never concrete plugins.
- **Service** — the runtime object a plugin registers for a capability.
- **Distribution** — the default set of plugins and config shipped with the
  CLI. Users layer their own plugins and config on top.
- **Slot** — a named place in the UI (`sidebar.actions`) that renders
  contributions.
- **Contribution** — an item with a stable id placed into a slot; it can be
  hidden, reordered, wrapped or replaced.
- **Hook** — a named pipeline (`before` / `after` / `around`) through which
  behaviour can be changed without touching the owning plugin.
- **Command** — an operation declared once (name, Zod input/output,
  permissions, handler) and exposed as an RPC method, a CLI subcommand and an
  MCP tool.
- **Disposable** — the handle every registration returns; disposing a plugin
  disposes everything it registered.
- **Config layer** — one level of JSONC config: distribution → node →
  project on a node; distribution → node → **device** on a client. Later
  layers win.
- **Config section** — one plugin's part of the config (`jhin.http`),
  declared with a Zod schema; the settings page renders it as a form from
  that schema.
- **Node** — one running Jhin server, identified by a stable `nodeId` and an
  Ed25519 key pair. T3 Code calls this an environment.
- **Machine kind** — what a node runs on (`laptop`, `desktop`, `server`,
  `cloud`, …), shown as its icon: what the node detects, unless its owner
  chose one (`jhin.host.machine`). T3 Code's environment icon.
- **Mesh** — the set of nodes of one owner that know about each other and
  route requests between themselves. There is no primary node.
- **Catalog** — the replicated mesh metadata: nodes, status, capabilities,
  projects, thread metadata.
- **Relay** — a node forwarding a request to a node the sender cannot reach
  directly.
- **Address** — a stable link `jhin://<nodeId>/<kind>/<id>`, resolvable
  through any node.
- **Client** — the web UI (and later Electron and mobile packagings of it).
  It can connect to several nodes at once.
- **Project** — a working directory, usually a git repository, on a specific
  node. Every node has a built-in **scratch project** for chats without a
  project.
- **Thread** — a conversation inside a project, stored as an append-only
  event log owned by one node.
- **Turn** — one exchange in a thread: a user message and the agent's response.
  Every turn carries an `agentId`.
- **Item** — one unit inside a turn: a message, a tool call, a streamed delta.
- **Agent** — the actor executing turns. Reserved as a separate entity with
  the address `jhin://<nodeId>/agents/<id>`.
- **Agent runtime** — the capability that executes turns: an own agent loop
  or a wrapper over an existing agent. The distribution ships Claude Code
  (`jhin.agent-claude`) and a fake one for tests and demos.
- **Session** — an agent's own conversation state for a thread (Claude Code
  keeps it in a session named after the thread); a turn resumes it.
- **Live session** — an agent process kept running between a thread's turns,
  so the next turn goes to it instead of starting the agent and resuming the
  session; it ends when idle too long, with its thread or on request.
- **Agent credential** — a bearer token the node's MCP server issues to one
  agent process for a thread (`mcp.server@1`), with only the permissions it
  names; revoked when that process ends.
- **Agent registry** — the runtimes of a node (`agent.registry@1`); a thread
  records which one, with which model, runs its turns.
- **Runtime mode** — how freely an agent acts: `approval-required`,
  `auto-accept-edits` or `full-access` (T3 Code's access modes).
- **Interaction mode** — `default` (build) or `plan`: whether the agent
  changes things or proposes a plan.
- **Request** — something a running turn asks the user: an **approval** of a
  tool call or **questions**. Answered with `threads.respond`; closed when its
  turn ends.
- **Follow-up** — a message sent while its thread runs a turn: it waits in
  the client's queue and goes out once the thread is free.
- **Work log** — the reasoning, tool calls and answered requests of a turn,
  shown between its messages and folded once the turn ends.
- **Event** — an entry in an event log with a per-stream monotonic
  `sequence`. Event types are namespaced per plugin (`agent.turn.started`).
- **Live stream** — a stream a plugin keeps in memory instead of the event
  log (`rpc.streams@1`): clients subscribe to it like to any stream, but only
  what the plugin still keeps is replayed, and nothing survives a restart.
- **Terminal** — a shell on a node, in a pseudo terminal (PTY), started for
  a thread in its project's folder under an id the client picks (`term-1`).
  Its output is a live stream; the node keeps its **scrollback** for clients
  that open it later. Several terminals of a thread show in the **terminal
  drawer** under the chat, as tabs and split groups (T3 Code's terms).
- **Sequence** — the position of an event in its stream; used to catch up
  after a disconnect without gaps or duplicates.
- **Inspector** — the `inspect` command and dev panel showing the live state
  of a node.
- **Keybinding** — a rule `{ key, command, when }` running a command on a
  shortcut; `when` tests **context keys** that plugins set (`composerFocus`).
- **Command palette** — the searchable list of titled commands, projects and
  threads (⌘/Ctrl+K).
- **Visit** — when a thread was last seen on this device, in its node's own
  time; a turn that ended after it shows the thread as unread.
- **Settled** — a thread that needs nothing more, settled by hand or by
  itself after three days without activity and with no turn running or
  waiting for the user. The sidebar lists it on its Settled shelf instead of
  among the active threads until it is un-settled or runs again (T3 Code's
  term).
- **Pinned** — a thread kept on top of the sidebar's list, in an order the
  user drags it into.
- **Snoozed** — a thread hidden on the sidebar's Snoozed shelf until a time;
  it wakes earlier when it asks for something, fails or completes, and then
  says "Woke".
- **Source control** — what a node reads of its projects' git repositories
  (`source-control.git@1`): the checked-out branch, ahead/behind, uncommitted
  changes, diffs, branches and the pull request of a branch.
- **Thread branch** — the branch a thread works on: the one checked out in
  its project when the thread was created or one of its turns started or
  ended, or the one it was switched to. The card shows it, and whether it is
  still checked out.
