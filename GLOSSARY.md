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
  trailhead. Knowledge without a route does not exist for an agent. A
  Markdown link, or a **mention**: a path in backticks (`docs/map.md#shape`).
- **Section address** — `path#heading` (or `path#D11` for a decision): how
  `context.read` names one section of a page.
- **Reachability** — whether every page of the library can be reached from
  the trailhead by routes; `jhin context.map` reports the pages it cannot
  reach and the routes that lead nowhere.
- **Maturity** — how far a page or section is trusted: `observation`,
  `note`, `insight` or `canon`, from its front matter or its location
  (`jhin.context` config). Canon wins on conflicts.
- **Canon** — knowledge the project relies on: `AGENTS.md`, this file,
  implemented plans, the map. Below it, in falling trust: insight, note,
  observation, exhaust.
- **Lore** — `docs/lore/`: named stories of recurring failures ("moonbase"),
  told instead of adding one more rule.
- **Lore brief** — the lore handed to an agent on start or after a
  compaction (`lore.brief`): each story's name and lesson, or the whole
  stories.
- **Router skill** — the skill generated from the trailhead and the map
  (`jhin context.skill.install`) that sends an agent to the right part of
  the library.

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
- **Permission** — what a command or a stream needs (`threads.read`), as
  declared by its plugin. A **grant** is what a caller holds: a permission,
  a namespace pattern (`git.*`) or `*` (everything). T3 Code calls them
  scopes.
- **Device token** — a node's token for one client (`jhd1.…`), carrying the
  grants it was given; issued by pairing or by `auth.tokens.issue`, listed
  as an **authorized client** and revocable. The **owner token** is the
  node's own, holding `*`.
- **Disposable** — the handle every registration returns; disposing a plugin
  disposes everything it registered.
- **Config layer** — one level of JSONC config: distribution → node →
  project on a node; distribution → node → **device** on a client. Later
  layers win.
- **Config section** — one plugin's part of the config (`jhin.http`),
  declared with a Zod schema; the settings page renders it as a form from
  that schema.
- **Control slot** — `settings.config.control.<name>`: where a plugin
  contributes the control a config field asks for with `.meta({ control })`.
- **List of groups** — how the settings form shows an array of objects:
  each item a group of its fields, moved, removed and added as a whole.
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
  directly; also a stream a node forwards from a member to its own
  subscribers as it happens (`relay/<owner>/<stream>`), storing nothing.
- **Shared stream** — a stream a plugin lets mesh members read and relay
  (`mesh.streams@1`); members read only the thread streams otherwise.
- **Address** — a stable link `jhin://<nodeId>/<kind>/<id>`, resolvable
  through any node.
- **Client** — the web UI (and later Electron and mobile packagings of it).
  It can connect to several nodes at once.
- **Mode** — one way of working in the client, with its own sidebar and
  main area (`client.modes@1`); the route names it and a switcher shows when
  there is more than one (`docs/plans/agents.md#D741`).
- **Threads mode** — the default mode, T3 Code's layout: many projects, and
  the owner watches, interrupts and steers every turn.
- **Civilization mode** — the mode for long projects run by agent teams: the
  owner steers through the lead, missions and intent and watches health;
  agents' generations are observed there, not driven.
- **Project** — a working directory, usually a git repository, on a specific
  node. Every node has a built-in **scratch project** for chats without a
  project.
- **Thread** — a conversation inside a project, stored as an append-only
  event log owned by one node.
- **Turn** — one exchange in a thread: a user message and the agent's response.
  Every turn carries an `agentId`.
- **Rollback** — dropping a thread's turns after a turn (`threads.rollback`):
  the log keeps their events and records a `threads.thread.rolled-back`
  event; what shows a thread (agents' history, the timeline, forks, search)
  leaves the **dropped turns** out, while `threads.events` returns the log as
  written for clients to fold. T3 Code reverts to a checkpoint the same way.
- **Thread details panel** — the panel the chat header's "Toggle thread
  details panel" opens (T3 Code's thread details card): sections that
  plugins contribute to the `chat.thread.details` slot, among them
  **Lineage**, a thread's parent and forks.
- **Delegated task** — child work a thread hands to an agent of any runtime
  and model (`tasks.delegate`, T3 Code's `delegate_task`): a **child thread**
  (`relationshipToParent: "subagent"`) runs the task prompt, and the parent
  follows it by its task id and is woken when it ends.
- **Provider subagent** — a subagent the agent of a turn runs itself
  (Claude Code's `Agent` tool), shown as a child thread with
  `subagentOrigin: "provider"` that runs on its own; unlike a delegated
  task's thread, it takes no messages (orchestration.md D877).
- **Workflow** — a script that runs several agents (`agent`, `parallel`,
  `pipeline`, `phase`), each one a delegated task of the thread that started
  it (`workflows.run`). A **saved workflow** is one kept as
  `.jhin/workflows/<name>.js` in a project and run by its name.
- **Item** — one unit inside a turn: a message, a tool call, a streamed delta.
- **Agent** — the persistent actor executing turns, at the address
  `jhin://<nodeId>/agents/<id>` (OpenRig's _seat_). Every runtime is the
  implicit agent of its own id; a **defined agent** (`builder`) names its
  runtime, model and **role** (a short job description) in the `jhin.agents`
  config section (`docs/plans/agents.md#D604`).
- **Generation** — one thread of a defined agent, in its home project and
  marked with the agent's id (`generationOf`) on the thread record. The current generation takes
  the agent's work; `agents.rotate` starts the next one, which begins with
  the agent's inherited knowledge, not the old transcript.
- **Inherited knowledge** — the Markdown files in `.jhin/agents/<id>/` of an
  agent's home project, which its generations read on start and keep current.
- **Message** — what one party sends another with `agents.send`: an agent,
  a node's **owner** (`jhin://<nodeId>/owner`) or a Threads-mode thread. It
  carries its sender's address and a `traceId`. An **ask** (`agents.ask`)
  is a message that waits for its **answer** (`docs/plans/agents.md#D621`).
- **Inbox** — the messages and asks to a node's owner, open until the owner
  answers them, shown in Civilization mode.
- **Side turn** — a turn that answers an ask to an earlier generation in a
  fork of its thread, leaving the generation and the agent's current one as
  they were. The earlier generations an agent can be asked this way are its
  **library of minds**.
- **Agent runtime** — the capability that executes turns: an own agent loop
  or a wrapper over an existing agent. The distribution ships Claude Code
  (`jhin.agent-claude`), Codex (`jhin.agent-codex`), OpenCode
  (`jhin.agent-opencode`, off until enabled) and a fake one for tests and
  demos.
- **Model option** — something a turn chooses for its model besides the
  model itself: the reasoning effort, fast mode, the context window. A model
  declares its options; the composer's traits menu (T3's term) picks them.
  **Ultrathink** is Claude's effort written into the prompt itself.
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
- **Secret store** — where a node keeps secrets apart from its config files
  (`secrets.store@1`): sealed, its key in the OS keychain or a key file. A
  config file holds a **config secret reference** (`$secret:<id>`) instead,
  which resolves only at the place it was made.
- **Secret request** — a turn asking the user for a secret through a private
  card in the thread (`secrets.request`, T3's `request_secret`); the agent
  gets a **`secretRef`**, a one-use reference a tool consumes, never the
  value.
- **Follow-up** — a message sent while its thread runs a turn: it waits in
  the thread's **queue** on its node and starts the next turn once the
  thread is free, unless the queue is **held** after a stopped or failed
  turn.
- **Steer** — a message sent into the running turn instead of after it; the
  agent takes it into the work it is doing (`threads.steer`). For an agent
  that cannot steer, the turn stops and the message starts the next one at
  once (a **restart**, T3's restart dispatch).
- **Context record** — structured context a user message carries beside its
  text: a pull request, another thread, a terminal excerpt (T3's composer
  context). The text names it by a **context reference**, a
  `jhin-context://v1/<kind>/<id>` link, shown as a **chip**; the agent reads
  the records projected into the text (`plans/t3-parity.md` D1006).
- **Proposed plan** — a plan an agent proposes in plan mode for the user to
  accept (`agent.plan.proposed`); the composer offers to implement the latest
  one, in its thread or a new one. T3 Code's term.
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
- **Trim** — forgetting the oldest events of an event log stream while its
  head and numbering stay (`storage.eventlog@1.2`); a stream followed from a
  snapshot keeps only its newest events.
- **Inspector** — the `inspect` command and dev panel showing the live state
  of a node.
- **Keybinding** — a rule `{ key, command, when }` running a command on a
  shortcut; `when` tests **context keys** that plugins set (`composerFocus`).
- **Command palette** — the searchable list of titled commands, projects and
  threads (⌘/Ctrl+K).
- **Visit** — when a thread was last seen, in its node's own time; the node
  keeps it for every device (`lastVisitedAt`), a device its own where the node
  does not. A turn that ended after it shows the thread as unread.
- **Settled** — a thread that needs nothing more, settled by hand or by its
  node: after the days without activity the node is configured with (three
  by default) and with no turn running or waiting for the user, or when its
  pull request merged or closed. The sidebar lists it on its Settled shelf instead of
  among the active threads until it is un-settled or runs again (T3 Code's
  term).
- **Working section** — with T3's "Working section (beta)" device setting
  on, the threads whose turn runs leave the active threads for a section
  below them, and come back on top once the turn ends or asks for
  something.
- **Pinned** — a thread kept on top of the sidebar's list, in an order the
  user drags it into.
- **Snoozed** — a thread hidden on the sidebar's Snoozed shelf until a time;
  it wakes earlier when it asks for something, fails or completes, and then
  says "Woke".
- **Source control** — what a node reads of its projects' git repositories
  (`source-control.git@1`): the checked-out branch, ahead/behind, uncommitted
  changes, diffs, branches and the pull request of a branch.
- **Forge** — where a repository's pull requests live: GitHub (and GitHub
  Enterprise), GitLab, Azure DevOps, Bitbucket, Forgejo or Gitea, read
  through its CLI or API (T3 Code's source control provider).
- **Git action** — committing, pushing and creating a pull request in a
  project, alone or stacked in that order (T3 Code's `commit_push_pr`), from
  the chat header or the `git.action.run` command. A **feature branch** is a
  new branch named after the changes, created for the commit.
- **Linked pull request** — a pull request recorded on a thread (by hand, by
  an agent, or created by a git action), shown on its card; linked pull
  requests whose bases are each other's heads form a **stack**.
- **Watch** — a thread following one of its linked pull requests: when its
  checks finish, someone else comments (a **remark**) or its branch
  conflicts, a message wakes the thread; it stops when the pull request
  merges or closes, or is unwatched.
- **Thread branch** — the branch a thread works on: the one checked out in
  its project when the thread was created or one of its turns started or
  ended, or the one it was switched to. The card shows it, and whether it is
  still checked out.
- **Worktree** — a git worktree of a project that a thread works in instead of
  the project's own folder (`worktreePath`); its turns, branch, status and
  diffs are the worktree's. The project's folder is the **local checkout**.
- **Checkpoint** — a snapshot of a thread's working directory before its first
  turn and after each turn (a commit under `refs/jhin/checkpoints/`), from
  which a turn's diff is read and to which a thread can be reverted.
- **Scheduled task** — a prompt a node sends on its own: on an interval, at a
  time of day on chosen weekdays, or when its **webhook** URL is called. A
  run goes to the thread the task is bound to, or to a new thread each time
  (T3 Code's term; `jhin.scheduler`).
- **Preview tab** — a page of the node's headless browser, opened for a
  thread by an agent or the user; its frames stream to the **right panel**,
  where the user watches it. Its **owner** is the agent session that opened
  it, a **viewer** (a panel watching it) that took control, or nobody
  (**unclaimed**). T3 Code's collaborative browser tab.
- **Viewer** — a client panel watching a preview tab, named by an id the
  client picks; the one **holding control** sends the page its input.
- **Intent** — one paragraph on what a project is for. The **intent chain**
  of a slice is its spec → its mission's outcome → its project's intent
  (`missions.chain`), what an agent walks back up to ("moonbase").
- **Mission** — a planned outcome of a project, with its slices in
  **waves**: the slices of a wave run in parallel, waves one after another,
  and a slice depends only on slices of earlier waves.
- **Slice** — one change in a mission: a **spec** (what must work), an
  assignee (an agent's or the owner's address), a status, the threads working
  on it, and a **proof** recorded when it is done (commands with output,
  screenshots, links; small on purpose).
- **Process** — the steps of a level as data: a slice's (spec → build →
  test), a mission's between its slices (merge), a project's between missions
  (release). A slice records its current **step**.
