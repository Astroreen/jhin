# Glossary

One word per concept. Use these terms in code, docs, commits and UI.

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
- **Node** — one running Jhin server, identified by a stable `nodeId` and an
  Ed25519 key pair. T3 Code calls this an environment.
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
  or a wrapper over an existing agent. The foundation ships only a fake one.
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
