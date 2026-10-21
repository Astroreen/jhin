# Map of Jhin

Everything Jhin already has, one line each: an inch deep, a mile wide. Read
it before building anything, so you extend what exists instead of building it
again next to it ([reinvent the wheel](lore/reinvent-the-wheel.md)). Each
line routes to the place that knows the details; open that only when you need
it.

The live truth of a running node is `jhin inspect` (plugins, services,
hooks, slots, mesh) and `jhin host.commands.list`. This map is the
territory's outline; when they disagree, fix the map.

When you add a package, plugin, capability or command, add its line here in
the same PR.

## Shape

- **Kernel** (`packages/kernel`): plugins, capabilities, services, hooks,
  commands, config layers, events, disposables, scoped state. Isomorphic, no
  product in it. → `plans/foundation.md#kernel-and-plugins`
- **Node** = a host (`packages/node-host`) running server plugins; **client**
  = the web app (`apps/web`) running a second kernel with client plugins.
  → `plans/foundation.md#mesh-nodes-transport`
- Every operation is a **command**, reachable as an RPC method, a CLI
  subcommand (`jhin <command>`) and an MCP tool. → `AGENTS.md` rule 6
- UI is **slots** and **contributions** with stable ids. → `plans/t3-parity.md#ui`
- A command or stream names **permissions**; a caller holds **grants**
  (`git.read`, `git.*`, `*`) checked by `holdsPermission` in `@jhin/sdk`.
  Remote callers hold the grants of their token; mesh calls carry their
  caller's. → `plans/security.md#permissions-and-scoped-tokens`

## Packages (`packages/`)

| Package                    | What it is                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@jhin/kernel`             | the isomorphic kernel                                                                                                                                                                                     |
| `@jhin/sdk`                | the public API plugins import (`definePlugin`, types, permission matching); the host provides it to user plugins                                                                                          |
| `@jhin/node-host`          | runs a node: loads plugins, hot reload, config files, logs, inspector, `host.*` commands                                                                                                                  |
| `@jhin/testing`            | test kernel, capability mocks, fake transport, in-memory mesh of N nodes                                                                                                                                  |
| `@jhin/rpc`                | JSON-RPC 2.0 over any channel: server sessions, reconnecting client, peers, flow control (`rpc.ack`, `rpc.subscription.ended`)                                                                            |
| `@jhin/mesh-core`          | the mesh without transport: membership, gossip, routing with relay, `jhin://` addresses                                                                                                                   |
| `@jhin/mcp-bridge`         | turns a command registry into MCP tools                                                                                                                                                                   |
| `@jhin/ui`                 | UI kit for client plugins: T3 Code-derived primitives, theme, slots                                                                                                                                       |
| `@jhin/host-api`           | contracts of what a host gives plugins (`host.paths@1`, `host.identity@1`, `host.plugins@1`)                                                                                                              |
| `@jhin/http-api`           | contract of `http.server@1`                                                                                                                                                                               |
| `@jhin/auth-api`           | contract of `auth.verifier@1` (1.1: a principal's `expiresAt`), principal ids and auth events                                                                                                             |
| `@jhin/mcp-api`            | contract of `mcp.server@1`: the MCP endpoint and agent credentials                                                                                                                                        |
| `@jhin/storage-api`        | contracts of `storage.kv@1`, `storage.eventlog@1.2` (records with an append, D208; `trim`, D496), an in-memory version, the contract tests                                                                |
| `@jhin/agent-api`          | contracts of `agent.runtime@1` (1.2: steering, model options, proposed plans; 1.3: defined agents), `agent.registry@1`, events, `visibleThreadEvents`, `agents.*`, `historyTranscript`, `pickEnvironment` |
| `@jhin/source-control-api` | contract of `source-control.git@1.1` and its events: statuses, thread branches, turn checkpoints (`TurnCheckpoint`); the diff panel's `source-control.diff-scopes@1`                                      |
| `@jhin/terminal-api`       | contract of `terminal.sessions@1`, its commands and stream events                                                                                                                                         |
| `@jhin/scheduler-api`      | contract of `scheduler.tasks@1`: tasks, triggers, deliveries, next-run arithmetic, events                                                                                                                 |
| `@jhin/preview-api`        | contract of `preview.browser@1`: tabs, the tools' inputs and results, stream events, viewport presets, URL normalisation                                                                                  |
| `@jhin/client-api`         | contracts of client capabilities: connections, navigation, mesh, machines                                                                                                                                 |

## Server plugins (`plugins/`)

| Plugin                | Provides                                                                                                                                             | Commands                                                                                                                                                                                                                                                                   | Plan                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `jhin.http`           | `http.server@1` (1.2: `requestedHost`)                                                                                                               | `http.info`                                                                                                                                                                                                                                                                | `foundation.md`                                     |
| `jhin.auth-token`     | `auth.verifier@1`: the owner token and scoped device tokens                                                                                          | `auth.token.show`, `auth.token.rotate`, `auth.tokens.issue`, `auth.clients.list`, `auth.clients.revoke`, `auth.clients.revoke-others`, `auth.permissions.list`, `auth.pairing.create`, `auth.pairing.list`, `auth.pairing.revoke`; `POST /auth/pair`, `/auth/session`      | `foundation.md`, `security.md`                      |
| `jhin.transport-ws`   | `rpc.streams@1` (1.1: `guard` for event log streams); every command over WS; drops revoked and expired tokens; `Origin` allowlist (`allowedOrigins`) | —                                                                                                                                                                                                                                                                          | `foundation.md`, `security.md`                      |
| `jhin.storage-sqlite` | `storage.kv@1`, `storage.eventlog@1.2`                                                                                                               | —                                                                                                                                                                                                                                                                          | `foundation.md`                                     |
| `jhin.mcp-server`     | `mcp.server@1`; every command as an MCP tool                                                                                                         | —                                                                                                                                                                                                                                                                          | `foundation.md#D39`                                 |
| `jhin.mesh`           | nodes of one owner, relay, addresses                                                                                                                 | `mesh.invite`, `mesh.join`, `mesh.nodes`, `mesh.call`, `mesh.resolve`, `mesh.open`, `mesh.close`, `mesh.config.*`                                                                                                                                                          | `foundation.md`                                     |
| `jhin.threads`        | `agent.registry@1`; projects, threads (with an own `worktreePath`), turns as events; turn hooks                                                      | `projects.*` (incl. `projects.write-file`), `threads.*` (history, search: `t3-parity.md#thread-history-w2`) (`threads.queue.*`, `threads.steer`), `agents.list`                                                                                                            | `foundation.md`, `t3-parity.md`                     |
| `jhin.agent-claude`   | Claude Code as an agent runtime; model options from T3's manifest (`model-catalog.ts`)                                                               | `claude.sessions.list`, `claude.sessions.close`; event `claude.session.files.deleted`                                                                                                                                                                                      | `providers.md`                                      |
| `jhin.agent-codex`    | Codex (`codex app-server`) as an agent runtime                                                                                                       | `codex.sessions.list`, `codex.sessions.close`                                                                                                                                                                                                                              | `providers.md#codex-w7`                             |
| `jhin.agent-fake`     | `agent.runtime@1`, deterministic                                                                                                                     | —                                                                                                                                                                                                                                                                          | `foundation.md`                                     |
| `jhin.agent-opencode` | OpenCode 2 as an agent runtime (off until enabled)                                                                                                   | —                                                                                                                                                                                                                                                                          | `providers.md`                                      |
| `jhin.orchestration`  | delegated tasks, thread launches, workflow scripts                                                                                                   | `tasks.*`, `orchestration.capabilities`, `orchestration.launch`, `workflows.*`                                                                                                                                                                                             | `orchestration.md`                                  |
| `jhin.source-control` | `source-control.git@1.1`; checkpoints taken in the turn hooks; git actions' progress as a live stream                                                | `git.status`, `git.diff` (incl. the `turn` scope), `git.checkpoints`, `git.branches`, `git.checkout`, `git.thread.status`, `git.action.run`, `git.pull`, `git.init`, `git.pr.link`, `git.pr.unlink`, `git.pr.list`, `git.pr.watch`, `git.pr.unwatch`, `git.pr.watch.check` | `source-control.md`                                 |
| `jhin.terminal`       | `terminal.sessions@1` (PTY, history kept on restart)                                                                                                 | `terminals.open`, `.write`, `.resize`, `.list`, `.get`, `.close`                                                                                                                                                                                                           | `terminal.md`                                       |
| `jhin.preview`        | `preview.browser@1`: a headless Chromium with tabs per thread; frames and tabs as live streams                                                       | `preview.*` (T3's `preview_*` tools: `.open`, `.snapshot`, `.click`, …, `.list`, `.close`), `preview.tab.*` (the panel's)                                                                                                                                                  | `preview.md`                                        |
| `jhin.scheduler`      | `scheduler.tasks@1`; interval, time-of-day and webhook tasks                                                                                         | `scheduler.tasks.*`, `scheduler.webhooks.rotate`, `scheduler.deliveries.*`                                                                                                                                                                                                 | `orchestration.md#w11-scheduled-tasks-and-webhooks` |
| `jhin.web-ui`         | serves the web client                                                                                                                                | `web-ui.info`                                                                                                                                                                                                                                                              | `foundation.md`                                     |
| `jhin.example`        | the template for new plugins                                                                                                                         | `example.greet`                                                                                                                                                                                                                                                            | `plugins/example/README.md`                         |

The host itself adds `host.inspect`, `host.identity`, `host.commands.list`,
`host.config.get`, `host.config.patch`, `host.config.edit` (leaf paths, D476),
`host.config.schema`,
`host.plugins.reload` and `host.plugins.rescan`.
`@jhin/host-api`'s `sendConfigChange` sends a config change to a node of any
age (`configEdits`, `configChange`; `config-ui.md` D475).

## Client plugins (`apps/web/src/plugins/`)

| Plugin            | What it does                                                                                                                                                                                                                                                       | Plan                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ui-host`         | the layout and its slots, appearance                                                                                                                                                                                                                               | `t3-parity.md#ui`                                                                         |
| `connections`     | saved nodes and their RPC clients (`client.connections@1`)                                                                                                                                                                                                         | `t3-parity.md`                                                                            |
| `navigation`      | the route in the URL fragment (`client.navigation@1`)                                                                                                                                                                                                              | `t3-parity.md`                                                                            |
| `mesh`            | one mesh feed per connection (`client.mesh@1`)                                                                                                                                                                                                                     | `foundation.md`                                                                           |
| `machines`        | node machine icons and their picker (`client.machines@1`)                                                                                                                                                                                                          | `t3-parity.md#node-machine-icons`                                                         |
| `threads-store`   | thread catalogs per node, kept current                                                                                                                                                                                                                             | `t3-parity.md`                                                                            |
| `visits`          | when a thread was last seen on this device (`client.visits@1`)                                                                                                                                                                                                     | `t3-parity.md`                                                                            |
| `sidebar`         | nodes, projects, thread cards, pinned, Snoozed and Settled shelves                                                                                                                                                                                                 | `t3-parity.md#sidebar-follow-up`                                                          |
| `thread-actions`  | the actions menu of a thread; the undo notice (`client.undo@1`)                                                                                                                                                                                                    | `t3-parity.md`                                                                            |
| `chat`            | the thread view, composer, work log, requests, proposed plans (`chat.plan.implement`, `chat.plan.implement-new-thread`), the node's queue and steering (`chat.queue.steer-next`, `chat.queue.edit-latest`, `chat.composer.send-alternate`)                         | `t3-parity.md#composer-w6`, `t3-parity.md#server-side-queue-and-steering-w1-t3-roadmapmd` |
| `command-palette` | ⌘/Ctrl+K                                                                                                                                                                                                                                                           | `t3-parity.md`                                                                            |
| `keybindings`     | shortcuts for client commands, overridable per command                                                                                                                                                                                                             | `t3-parity.md`                                                                            |
| `notifications`   | system notifications, sounds and toasts when a thread needs you                                                                                                                                                                                                    | `t3-parity.md`                                                                            |
| `settings`        | the settings page, config forms from schemas                                                                                                                                                                                                                       | `config-ui.md`                                                                            |
| `inspector`       | the dev panel showing `host.inspect`                                                                                                                                                                                                                               | `foundation.md#D36`                                                                       |
| `source-control`  | branch, diff, pull request indicators, branch toolbar, git actions, diff panel on `@pierre/diffs` (file tree, base ref picker) with scopes as contributions (`source-control.diff-scopes@1`, D283; turns among them); slot `chat.turn.footer` (changed files card) | `source-control.md`                                                                       |
| `terminal`        | the terminal drawer and the card's terminal indicator                                                                                                                                                                                                              | `terminal.md`                                                                             |
| `scheduler`       | the Settings → Scheduled tasks page (`scheduled-tasks` section, `scheduler.task.actions` slot)                                                                                                                                                                     | `orchestration.md#w11-scheduled-tasks-and-webhooks`                                       |

## Apps, tests, scripts

- `apps/jhin` — the CLI `jhin` (published as `jhin-ai`): `serve`, `inspect`,
  and every command as a subcommand.
- `apps/web` — the web client.
- `e2e/` — Playwright end-to-end tests.
- `scripts/verify.ts` (`pnpm verify`), `scripts/pack.ts`,
  `scripts/pack-smoke.ts` (`pnpm pack:smoke`), `scripts/t3/` (run from a
  checkout, see its README).

## In progress

The W1–W18 workstreams in [`plans/t3-roadmap.md`](plans/t3-roadmap.md)
(queue, history, checkpoints and worktrees, git actions, Codex, OpenCode,
delegated tasks, scheduled tasks, preview, pairing, desktop, …). Before you
start anything that sounds like one of them, check its row there.

The agent workstreams A1–A8 in [`plans/agents.md`](plans/agents.md), the
client's second mode (Civilization, next to Threads):
persistent agents with addresses, messaging between agents and the owner,
missions and slices, the context library and lore, teams, refocus and
health.
