# Foundation plan

Status: **implemented** — all PRs below are merged; D47's end-to-end proof
passes in CI. This file records every
decision taken while designing the foundation of the codebase, everything
explicitly deferred, and the PR-by-PR plan with acceptance criteria.

## Goal

Jhin is a self-hosted AI harness / meta harness. The application is a small
kernel plus a distribution of plugins; UI, protocols, connections, servers and
MCP are all plugins. Users change or extend anything through config and their
own plugins, without forking. T3 Code is the main reference for behaviour, UI
and engineering practices.

## Decisions

### Scope

- **D1. Foundation = kernel + tooling + an end-to-end vertical slice** built
  from real plugins (transport, fake agent provider, chat UI, mesh). The plugin
  API is derived from these plugins, not designed up front.

### Stack and tooling

- **D2. TypeScript everywhere.** Runtime: **Node 24** (LTS).
- **D3. Plain TypeScript for the public plugin API** — VS Code style
  `Disposable`, **Zod** schemas. No Effect in the public API.
- **D4. Monorepo tooling follows T3 Code:** pnpm workspaces, **Vite+** (`vp`)
  for task running, Vitest, oxlint and oxfmt; **knip** for dead code.
- **D5. Typechecker: TypeScript 7** (native port, `tsgo`). `tsc-rs` may be
  tried later; swapping is a one-command change.
- **D6. UI: React 19 + Vite**, with T3 Code's web stack: Tailwind 4, Base UI,
  `cva`, `tailwind-merge`, lucide, TanStack Router, zustand.
- **D7. License: Apache-2.0.** Code copied from T3 Code (MIT) keeps its notice
  in `THIRD_PARTY_NOTICES.md`.

### Kernel and plugins

- **D8. One isomorphic kernel** for server and client: no Node or DOM
  dependencies; module loading through an injected adapter.
- **D9. Kernel contents:** loader, lifecycle, dependency graph, service
  registry (capability id + semver), hooks (before/after/around), commands,
  config layers, events, disposables, scoped state that survives reload.
  UI slots live in the UI host plugin; transport lives in the transport plugin.
- **D10. Plugin = npm package**; manifest in the `package.json` `"jhin"` field
  (`id`, `version`, `apiVersion`, `side: server | client | both`,
  `provides` / `requires` as capability + semver range, `entry`). The kernel
  validates manifests and the graph before running any plugin code. Code
  exports `definePlugin({ activate(ctx) })`. In the workspace `entry` is
  TypeScript, run from source; a packed package names its built JavaScript
  instead (`publishConfig.jhin` overrides `jhin` in the tarball), because Node
  does not strip types under `node_modules`.
- **D11. Dependencies target capabilities**, not concrete plugins
  (`ui.sidebar@^1`), so any implementation is replaceable.
- **D12. First-party plugins use only the public API.** UI is slots plus
  contributions with stable IDs (hide, reorder, wrap, replace). Behaviour
  changes go through named hooks.
- **D13. Execution model in the foundation:** in-process server plugins and
  client UI plugins, both hot reloadable. Out-of-process plugins are deferred,
  but the plugin contract stays serialisable and async so they fit later.
- **D14. Server hot reload:** a watcher disposes the plugin and its
  dependants, re-imports with cache busting, re-activates along the graph.
  Also triggerable by a `reload plugin` command. A changed manifest, or a
  plugin added to or removed from a plugin location (D15), re-resolves the
  graph the same way: only the plugins concerned and their dependants restart
  (`kernel.plugins.updated`, `host.plugins.rescan`); an invalid manifest keeps
  the previous one and shows in the inspector. Two sources with one id (a
  kernel host that applies no precedence) stop the running plugin: both copies
  are blocked as duplicates until one goes; the node host never passes
  duplicates, a later layer shadows an earlier one. Known limitation: old modules
  stay in Node's memory.
- **D15. Plugin locations and precedence** (same id → topmost wins, i.e.
  "fork one plugin, not the app"): distribution (npm deps of the CLI package)
  → user (`~/.jhin/plugins/<id>/`) → workspace (`.jhin/plugins/`) → dev paths
  from config.
- **D16. User client plugins load at runtime without a rebuild:** built ESM,
  served by the node (`--ui` mode) or read from the local plugin folder
  (`client` mode); shared dependencies (React, `@jhin/ui`) come from an import
  map. An e2e test proves a user plugin adds a sidebar button and hot reloads.
- **D17. One command registry, every surface:** a command is declared once
  (name, Zod input/output, required permissions, handler) and is exposed
  automatically as an RPC method, a CLI subcommand and an MCP tool. An
  invocation without a caller is trusted in-process code and skips permission
  checks; every remote surface (RPC, CLI over a connection, MCP) must set one.

### Config

- **D18. Config format: JSONC + JSON Schema** assembled from plugin schemas.
  Code lives only in plugins.
- **D19. Config layers:** distribution → node (user) → project (workspace).
  No separate "mesh" layer.
- **D20. Multi-target settings like T3 Code:** the settings UI has a scope
  picker (environments: one / several / all; projects: one / several / all).
  Saving fans the same patch out to every selected node and project through
  the mesh. Each node exposes `config.get` / `config.schema` / `config.patch`
  as commands (D17).

### Mesh, nodes, transport

- **D21. Three install modes, one CLI:** `jhin client` (web client only,
  connects to remote nodes), `jhin serve` (headless node), `jhin serve --ui`
  (node that also serves the client). The mode is just a set of plugins.
  Electron becomes a fourth packaging of the same client later.
- **D22. Single owner, single trust domain.** Federation between owners is
  not planned.
- **D23. Node identity:** each node generates a stable `nodeId` and an
  Ed25519 key pair on first start. `nodeId` is _who_, URL is _where_.
- **D24. Stable addresses:** `jhin://<nodeId>/threads/<id>`, resolvable
  through any node as `https://<any-node>/n/<nodeId>/...`. Human-readable
  aliases may sit on top; the `nodeId` form stays canonical.
- **D25. Mesh replicates the catalog only:** nodes, status, capabilities,
  thread metadata. Thread content lives on the owner node. Running work on
  another node ("create a thread on node X") is built on this.
- **D26. History sync into the local node database**, two policies, both in
  the foundation:
  - `on-open` — pull missing events by `sequence` when a thread is opened;
  - `eager` — keep copies of other nodes' threads in the background.
    Default for `serve` nodes: `on-open`, user may enable `eager`. The owner
    node stays the source of truth.
- **D27. Joining:** `jhin mesh invite` issues a one-time token, `jhin mesh
  join <url> <token>` uses it; keys are exchanged and membership spreads by
  gossip. Implemented as a plugin on top of `auth.token`.
- **D28. Routing with relay:** A can reach C through B; shortest path over the
  neighbour table.
- **D29. Transport plugin:** WebSocket + JSON-RPC 2.0 + Zod schemas, with a
  per-stream `sequence` for catch-up. Same protocol for client↔node and
  node↔node; mesh routing forwards the same message to the next hop.
- **D30. Auth in the foundation:** static bearer token generated on first
  start, as the replaceable plugin `auth.token`.
- **D31. Storage:** `storage.kv` and `storage.eventlog` capabilities,
  implemented by a plugin on `node:sqlite`.

### Agents and threads

- **D32. Terminology follows T3 Code:** thread → turn → item. A
  `GLOSSARY.md` is added.
- **D33. "Agent runtime" capability** fits both an own agent loop and
  wrappers over existing agents (Claude Code, Codex, OpenCode). Minimal
  interface: `startTurn`, a stream of items, `interrupt`. The foundation ships
  **only a fake provider**.
- **D34. Thread events:** an append-only log with `sequence`; event types are
  namespaced per plugin (`agent.turn.started`, `git.pr.linked`, …) and the UI
  renders them through slots by type.

### UI

- **D35. Copy T3 Code's visual layer** (components, layout, styles); rewrite
  the data layer on the Jhin plugin API. Foundation subset: sidebar with mesh
  nodes and threads, streaming chat view, plain textarea composer, inspector
  dev panel. Every part is a plugin with slots.

### Making the system visible to AI

- **D36. Inspector:** `jhin inspect` (also a command, so RPC and MCP) returns
  JSON: loaded plugins with status and activation errors, services, hooks,
  slots, mesh neighbours, recent events. A dev panel shows the same in the web
  client.
- **D37. Structured JSON logs** (pino) with `plugin`, `nodeId` and an
  end-to-end `traceId` from client click through relay nodes to the provider;
  written to a file AI can read.
- **D38. `@jhin/testing`:** test kernel, mock implementation of any
  capability, network-free fake transport, in-memory mesh of N nodes in one
  process.
- **D39. MCP server plugin** (`mcp.server`) on every node, Streamable HTTP
  plus a stdio wrapper, exposing the command registry. Consumers: agents inside
  Jhin threads and external agents developing Jhin. Foundation tools: inspect,
  list nodes and threads, create a thread on any node, send a message, read
  thread events.
- **D40. UI verification:** Playwright e2e with role/accessibility-tree
  locators; component tests in Vitest browser mode; visual regression only for
  a few key screens. No Storybook yet.
- **D41. One verify command:** `verify` runs typecheck, lint, unit and e2e,
  cached, with `--affected`, machine-readable output and a short summary.
- **D42. Agent rules (from T3 Code) in `AGENTS.md`:** smallest proof locally
  (only affected files, tests, packages); full runs belong to CI; no `sleep`
  or timeouts in tests — wait for a concrete event or drain; PRs require
  concrete evidence.

### Process

- **D43. CI on GitHub Actions** for every push and PR: typecheck, lint, unit,
  Playwright e2e (headless Chromium), knip.
- **D44. Claude reviewer:** `anthropics/claude-code-action`, authenticated
  with `CLAUDE_CODE_OAUTH_TOKEN` (subscription); automatic review on every PR
  plus `@claude` mentions. The user sets up the secret and the GitHub App.
- **D45. Workflow:** feature branch → PR → CI + Claude review → merge; `main`
  is protected and requires green CI.
- **D46. This plan lives in the repository** (`docs/plans/foundation.md`),
  landed in the first PR together with `GLOSSARY.md` and an updated
  `AGENTS.md`.
- **D48. Package names:** the CLI is published as `jhin-ai` (binary `jhin`);
  fallback `@astroreen/jhin`. Internal packages use the `@jhin/*` scope if the
  npm org is free, otherwise `@astroreen/*`.

### Projects and agents (data model)

- **D49. Projects like T3 Code:** a project is a working directory (usually a
  git repository) on a specific node; threads belong to a project; a project
  has its own config layer (D19); projects are part of the replicated mesh
  catalog.
- **D51. Chats without a project use a built-in scratch project** on every
  node (own empty working directory, shown as "No project"). A thread always
  belongs to a project; schemas carry no nullable `projectId`.
- **D52. Agents are reserved as a separate entity:** the address
  `jhin://<nodeId>/agents/<id>` is reserved and every turn carries an
  `agentId` (the fake provider's agent in the foundation). The agent entity
  itself and multi-agent threads are deferred.

### Settings fan-out

- **D50. Offline targets of a settings fan-out:** the change is queued in the
  sending node's event log and applied when the target returns; the UI shows
  pending targets. If the target changed the same setting locally in the
  meantime, the later change wins and the conflict is shown in the UI.

### Foundation end-to-end proof

- **D47.** Three nodes chained A–B–C; a client connected to A creates a thread
  on C and receives the fake provider's reply. A second test: the client sees
  two independent nodes at once.

## Deferred (not in the foundation)

- Out-of-process plugins (JSON-RPC child processes, any language, WASM).
- Real agent adapters: own LLM loop, Claude Code, Codex, OpenCode.
- Record/replay of real provider transcripts.
- Electron desktop app; Capacitor mobile app; PWA polish.
- Native capability layer (camera, QR scanner, BLE, NFC, haptics, widgets,
  Live Activities).
- Notifications: providers as plugins (UnifiedPush/ntfy, blind relay for
  APNs/FCM, Web Push, Telegram, Electron native).
- QR pairing with one-time codes and device tokens (replaces `auth.token`).
- Discovery plugins: mDNS, Tailscale.
- Hiding selected nodes on a specific client.
- History sync into on-device storage (IndexedDB, SQLite in Electron/mobile).
- Settings UI with the scope picker (the config commands and fan-out exist in
  the foundation).
- Source-control plugin: linking PRs to threads, watching PRs; matching MCP
  tools.
- "No project" chats in the UI (the scratch project exists in the data model,
  D51).
- Agent entity, several persistent agents attached to a node or project,
  multi-agent threads (D52 reserves the address and `agentId`).
- AI Civilization: agents messaging each other across nodes.
- Rich composer (tiptap), Storybook.
- OpenTelemetry export plugin.
- Trying `tsc-rs` instead of TypeScript 7.
- Publishing packages to npm.
- An `Origin` allowlist on the WebSocket transport: today the upgrade is
  authenticated by token only, so a page in the owner's browser that knows a
  token can call commands. It must still let `jhin client` and other nodes'
  web clients connect cross-origin (D21).
- Keeping node tokens somewhere safer than `localStorage` in the web client:
  any script on the client's origin (including user client plugins) can read
  them today.
- Runtime client plugins under `vp dev` need a `jhin serve --ui` node behind
  `JHIN_NODE_URL`: a headless `jhin serve` does not serve `/client/*`.
- Unloading a removed client plugin's modules: the browser keeps imported ES
  modules until a page reload (the plugin is deactivated and disposed).
- Signed mesh records: today any member can overwrite another member's
  record (key, URLs, neighbors) or claim a far-future version; acceptable in
  one owner's trust domain (D22), not beyond it.
- Scoped permissions for mesh links: a member's calls run with every
  permission (`node:<id>`, `*`) on every other member — including
  `host.config.write`, so any member can change any node's config.
- Trimming the `mesh/outbox` history: outcomes of delivered changes stay in
  the stream forever (`storage.eventlog@1` has no truncation); nothing reads
  it on a mesh change any more, so it only costs disk.
- Expiring queued config changes on a timer: today a change past
  `jhin.mesh.queueExpiryHours` is marked expired the next time the outbox is
  looked at (any mesh change, a fan-out, `mesh.config.pending`).
- Fan-out to several projects of a node (D20's project picker): the
  `project` layer is the project the node was started in; other projects'
  config files are not loaded by the node yet.
- Visual regression snapshots (D40): screenshots differ between the NixOS
  dev shell and CI runners; they need one pinned rendering environment (the
  Playwright container) before baselines are worth keeping.
- Freeing old module instances after a hot reload: every reload leaves the
  previous `?jhin-gen=N` modules in Node's ESM cache, so a long
  `serve --watch` session grows in memory (D14). Out-of-process plugins fix
  this.
- Watching a plugin location whose parent directory did not exist when the
  node started (`.jhin/plugins` in a project without `.jhin/`), and dev paths
  or distribution plugins added after start: `host.plugins.rescan` or a
  restart picks them up.
- A plugin copied into a plugin location file by file (not moved in whole)
  can be found before its entry file exists; it then fails to activate until
  its next change or `host.plugins.rescan`.
- Plugin location watching on macOS and Windows: it relies on recursive
  `fs.watch` of the user and workspace plugin directories, tested on Linux
  only; on large plugin trees every nested change wakes the watcher before
  the filter drops it.
- The storage contract suite (`@jhin/storage-api/contract`) in the packed
  package: it imports Vitest, so only the workspace has it today.

## PR plan

Every PR is green in CI and reviewed by Claude before merge (D43–D45). Each
PR lists the decisions it implements and the concrete proof required.
Mesh comes after the single-node chain works, so mesh failures never mix with
kernel or transport failures.

### PR 1 — Docs

Implements D7, D32, D42, D46.

- This plan, `GLOSSARY.md` (node, project, thread, turn, item, agent,
  capability, plugin, slot, contribution, command, hook), `AGENTS.md`
  rewritten with the agent rules, `LICENSE` (Apache-2.0),
  `THIRD_PARTY_NOTICES.md` stub.
- **Done when:** documents merged; `AGENTS.md` names the verify workflow that
  PR 2 provides.

### PR 2 — Monorepo skeleton

Implements D2, D4, D5, D41, D43, D44.

- pnpm workspace, Node 24 pin, Vite+ (`vp`), TypeScript 7 strict base
  config, oxlint, oxfmt, knip, staged hooks; one placeholder package with a
  test; `devenv.nix` moved to Node 24.
- `verify` script with `--affected` and machine-readable summary.
- GitHub Actions CI: typecheck, lint, unit, e2e job (placeholder Playwright
  test), knip. Claude review workflow (auto on PR + `@claude`).
- **Done when:** CI is green on the PR; a deliberately broken commit fails
  each job; Claude posts a review on the PR.

### PR 3 — Kernel and `@jhin/testing`

Implements D3, D8–D12, D17, D18, D19 (layers engine), D38 (test kernel and
capability mocks).

- `@jhin/kernel`: manifest parsing and validation, capability graph with
  semver, lifecycle, service registry, hooks, command registry with Zod
  schemas and permissions, layered JSONC config with merged JSON Schema,
  events, disposables, scoped state; module loading through an adapter; no
  Node or DOM imports (lint rule).
- `@jhin/sdk` surface: `definePlugin`, types.
- `@jhin/testing`: test kernel, capability mocks.
- **Done when:** unit tests cover graph errors (missing, cycle, version
  mismatch), activation failure isolation, dispose on deactivate, hook order,
  command validation, config layer precedence; the kernel builds for both a
  Node and a browser target.

### PR 4 — Server host, hot reload, inspector, logs, CLI

Implements D13, D14, D15, D36, D37; CLI part of D17 and D21 (`serve`).

- `@jhin/node-host`: filesystem loader, plugin locations and precedence,
  watcher-driven reload with cascade along the graph, `reload plugin`
  command.
- pino JSON logs with `plugin`, `nodeId`, `traceId` to a file.
- CLI package `jhin-ai`: `jhin serve`, `jhin inspect`, commands exposed as
  subcommands automatically.
- Example plugin in the repository.
- Public event types introduced here: `kernel.config.changed` (a config
  layer was set) and `host.config.rejected` (a config file failed to parse;
  the previous layer stays in effect).
- Until the transport exists (PR 6), `jhin inspect` and `jhin <command>` boot
  the node's plugins in-process, run, and stop; afterwards they talk to the
  running node.
- **Done when:** a test edits a plugin on disk and observes dispose →
  re-activate of it and its dependants with state preserved; a user plugin
  with the same id overrides a distribution plugin; `jhin inspect` JSON shows
  plugins, services, hooks and an activation error from a broken plugin.

### PR 5 — Storage

Implements D31.

- `storage.kv` and `storage.eventlog` on `node:sqlite`; per-stream
  monotonic `sequence`; read from a sequence.
- **Done when:** contract tests run against the SQLite plugin and the
  `@jhin/testing` in-memory mock; data survives a node restart.

### PR 6 — Transport and auth

Implements D29, D30.

- WebSocket + JSON-RPC 2.0 transport plugin (server and client sides); every
  command reachable as RPC; event subscriptions with catch-up from a
  `sequence`; fake in-process transport in `@jhin/testing`.
- `auth.token`: token generated on first start, printed once, checked on
  connect.
- **Done when:** tests cover reconnect with catch-up without gaps or
  duplicates, rejected connection without a token, `traceId` propagated from
  request to logs.

Implementation notes (PR 6):

- Protocol details: the WebSocket subprotocol is `jhin.v1`; browsers cannot
  set headers, so the token travels as a second subprotocol
  `jhin.token.<token>` that the server never echoes. After checking it the
  server sends `rpc.ready` first, or closes with code 4401 (the client then
  stops retrying). Subscription ids are chosen by the client, because backlog
  events arrive before `rpc.subscribe` returns. Reserved methods:
  `rpc.hello`, `rpc.subscribe`, `rpc.unsubscribe`; notifications `rpc.ready`,
  `rpc.event`. Every other method is a command name.
- `jhin.http` provides `http.server@1` for every plugin that needs HTTP (the
  transport now, MCP and the web client later); `jhin.host` also provides
  `host.trace@1` (AsyncLocalStorage, every log line gets `traceId`) and the
  `host.commands.list` command. Contracts live in `@jhin/http-api`,
  `@jhin/auth-api` and `@jhin/host-api`.
- Token rotation (`auth.token.rotate`) emits `auth.token.rotated`; the
  transport then closes every open connection with 4401, so a rotated-out
  token stops working at once. Tokens shorter than 43 characters (including
  an empty token file) are never accepted; such a file is regenerated.
- The CLI talks to a running node with `--url` (token read from the home by
  default); without it, it still boots the plugins in-process.

### PR 7 — Projects, threads, fake agent, MCP

Implements D33, D34, D39, D49, D51, D52.

- Projects (including the scratch project), threads, turns, items as
  namespaced events in the event log; "agent runtime" capability; fake
  provider with scripted, deterministic streaming replies and `agentId`.
- `mcp.server` plugin: Streamable HTTP plus stdio wrapper over the command
  registry; tools: inspect, list nodes/projects/threads, create thread, send
  message, read thread events.
- **Done when:** a test drives a full turn through RPC and reads it back
  through MCP; interrupt stops a streaming turn; an MCP client lists the
  tools generated from commands.

Implementation notes (PR 7):

- Contracts: `@jhin/agent-api` holds `agent.runtime@1` (`startTurn` returns
  `{ items, interrupt }`) and the thread event types: `threads.thread.created`,
  `agent.turn.started` (with `agentId`, D52), `agent.item.delta`,
  `agent.item.completed`, `agent.turn.completed`, `agent.turn.interrupted`,
  `agent.turn.failed`. A thread's stream is `thread/<id>`.
- `jhin.threads` commands: `projects.list`, `projects.create`, `threads.list`,
  `threads.create`, `threads.get`, `threads.events`, `threads.send`,
  `threads.interrupt`; one turn per thread at a time (`TURN_IN_PROGRESS`).
- MCP tool names are command names with `.` → `_` (`threads.send` →
  `threads_send`), reversible because command names have no `_`, and valid
  for model APIs that forbid dots. `jhin.mcp-server` is stateless Streamable
  HTTP at `POST /mcp` with `Authorization: Bearer <token>`; `jhin mcp` serves
  the same tools over stdio, in-process or against `--url`.

### PR 8 — Web client

Implements D6, D16, D21 (`client`, `serve --ui`), D35, D40; inspector dev
panel from D36.

- Client host on the isomorphic kernel; `ui.react` UI host plugin with slots
  and contributions; import map for shared dependencies; runtime loading of
  client plugins from the node or a local folder.
- Copied T3 Code visual layer: sidebar (nodes, projects, threads), streaming
  chat view, textarea composer, inspector panel; notice in
  `THIRD_PARTY_NOTICES.md`.
- **Done when:** Playwright e2e sends a message and sees the streamed fake
  reply in both `serve --ui` and `client` modes; e2e drops a user plugin into
  `~/.jhin/plugins/`, sees its sidebar button appear without a rebuild, edits
  it and sees the change hot reload; an e2e hides a first-party contribution
  through config; component tests run in Vitest browser mode; visual
  snapshots for the chat screen.

Split during implementation (PR 8):

- **PR 8a** — `@jhin/ui` (T3 Code-derived primitives, theme, `ui.slots@1`
  with error-isolated contributions), `@jhin/client-api`
  (`client.connections@1`, `client.navigation@1`), the `apps/web` client
  (isomorphic kernel with `side: "client"`; built-in plugins `jhin.ui-react`,
  `jhin.connections`, `jhin.navigation`, `jhin.sidebar`, `jhin.chat`,
  `jhin.inspector`), the `jhin.web-ui` server plugin and `jhin serve --ui`.
  Done when: Playwright sends a message and sees the streamed fake reply,
  stops a running turn and opens the inspector, against a real
  `jhin serve --ui`; slot behaviour is tested in Vitest browser mode.
- **PR 8b** — runtime loading of user client plugins (import map + shims of
  shared packages), their hot reload, hiding contributions through config,
  and `jhin client`. Done when: the remaining PR 8 criteria pass.

Implementation notes (PR 8b):

- Shared packages for runtime plugins (`react`, `react/jsx-runtime`,
  `react-dom`, `react-dom/client`, `@jhin/sdk`, `@jhin/ui`,
  `@jhin/client-api`) are separate build entries; an import map in
  `index.html` points the bare names at them, so plugins and app share one
  instance of each. A user client plugin is plain ESM, no build step needed.
- `jhin.web-ui` owns the `jhin.ui` config section (slot rules per slot) and
  serves `GET /client/plugins`, `/client/plugins/<id>/<rev>/…` (the revision
  in the path makes a reload re-import every file of the plugin),
  `/client/config` (only `jhin.ui`) and `/client/events` (SSE: `plugin`, `plugins`,
  `config`). `jhin.host` provides `host.plugins@1` (discovered plugins of both
  sides and their file changes).
- The watcher reloads any plugin of the node's own side that changed, including
  one that failed to activate: fixing a broken plugin's file activates it.
- Client plugin files and `jhin.ui` are served without a token (the page needs
  them before it has one); only entries ending in `.js`/`.mjs` are served.
- Client plugins added, removed or with a new manifest while a page is open:
  the node's rescan (D14) reports each such plugin to `host.plugins@1`
  listeners as a change to its `package.json`; `jhin.web-ui` then sends a
  `plugins` event, and the page re-reads `/client/plugins` and applies it
  with `kernel.update` — no page reload. A removed plugin that replaced a
  builtin brings the builtin back.
- Under `vp dev` the shared packages are virtual modules of the dev server,
  so their imports resolve to the same URLs as the app's; the import map
  points at them, and `/client/*` is proxied to the node (`JHIN_NODE_URL`).
- `jhin client` = `jhin.http` + `jhin.web-ui` (+ `jhin.host`): the web client
  alone, connecting to remote nodes.

### PR 9 — Mesh

Implements D22–D25, D27, D28.

- Node identity (`nodeId`, Ed25519 keys), `jhin mesh invite` / `jhin mesh
  join`, gossip of membership, replicated catalog (nodes, status,
  capabilities, projects, thread metadata), routing with relay, `jhin://`
  addresses and `/n/<nodeId>/...` resolution; in-memory mesh in
  `@jhin/testing`.
- **Done when:** in-memory tests cover join, gossip convergence, node leaving
  and returning, routing A→C through B, address resolution after a node
  changes its URL; one multi-process test does the same over real sockets.

Implementation notes (PR 9):

- `@jhin/mesh-core` holds the mesh logic, independent of transport; the
  `jhin.mesh` plugin wires it to WebSockets and HTTP. `@jhin/testing`
  re-exports its in-memory network.
- Links are two-way RPC over one WebSocket at `/mesh` (both ends serve and
  call), so a node without an address (behind NAT) is reached over the link it
  opened. A link presents `jhin.token.<nodeId>.<target>.<expiresAt>.<sig>`:
  an Ed25519 signature over `jhin-mesh-link:<nodeId>:<target>:<expiresAt>`,
  valid 5 minutes, for one target, from a known member only.
- Joining: `mesh.invite` returns a one-time code (15 minutes);
  `mesh.join {url, code}` posts the joiner's record to `POST /mesh/join` and
  gets the inviter's members back. Records are trusted within one owner (D22).
- Records carry `urls`, `neighbors` and a `version` that only grows (it is a
  time), so the newest wins across restarts. Gossip floods changes; routing
  uses an edge only when both ends list each other, so a node that went away
  drops out as soon as its neighbors notice.
- Calls: `mesh.call {node, method, params}` → `mesh.forward` hop by hop
  (at most 8). The target runs the command with caller `node:<origin>`.
- A relayed call is request/response for quick commands: each hop waits at
  most 30 s (`callDeadlineMs`) and reports `MESH_TIMEOUT`. Long work starts
  and returns at once (`threads.send` returns a turn id; the turn streams as
  events), so no deadline cuts it off. A `MESH_TIMEOUT` does not mean the
  command did not run (it may still be running on the target); the hop it
  names is best effort, since each hop waits only 10 ms less than the one
  before.
- `mesh.nodes` (the "list nodes" tool of D39), `mesh.resolve`, the `mesh`
  stream (`mesh.nodes.changed`) and `GET /n/<nodeId>/<path>` (307 to the
  node, D24). `jhin.host` provides `host.identity@1`. Config: `jhin.mesh.name`,
  `jhin.mesh.advertise` (`[]` = not directly reachable).

### PR 10 — History sync and settings fan-out

Implements D20, D26, D50.

- `on-open` and `eager` history policies into the local node database by
  `sequence`; config commands fanned out to selected nodes and projects;
  offline queue with later-wins and conflict reporting.
- **Done when:** tests show a thread from C readable on A after C goes
  offline (both policies); a patch to "all nodes" reaches an offline node
  after it returns; a concurrent local change produces a reported conflict.

Implementation notes (PR 10):

- History sync uses mirrors: `mesh.open {node, stream}` (or the `eager`
  policy, `jhin.mesh.history`) keeps `mirror/<node>/<stream>` in this node's
  log. A node next to the owner reads the stream itself over the link; a node
  further away asks the next hop to keep its own mirror and reads that, so
  every hop caches (D26). Sequences equal the source's (`expectedHead`), and a
  mirror catches up from its head whenever a route returns.
- `eager` follows every node's `threads` stream (one event per thread
  created, written by `jhin.threads`) and mirrors each thread it lists.
- `host.config.patch {layer, section, values, at}` edits the node's JSONC
  file keeping comments and records the time per section; an older change
  loses (`conflict`). `mesh.config.patch {nodes, layer, section, values}`
  applies one change everywhere; changes for unreachable nodes wait in the
  `mesh/outbox` stream and are delivered when a route exists
  (`mesh.config.delivered` / `mesh.config.conflict`).

- Neighbors may only read and copy `threads`, `thread/*`, `mirror/*/…` of
  those, and `mesh`; other streams (e.g. `mesh/outbox`) stay private.
  Opened mirrors are remembered and resume after a restart; `mesh.close`
  stops one.
- The link protocol's own methods (`mesh.gossip`, `mesh.forward`,
  `mesh.mirror`) are handled inside the mesh, not as commands: they are the
  transport between nodes, not operations of a node (an exception to
  AGENTS.md rule 6). `mesh.mirror` only accepts members' streams and at most
  10 000 copies per node. A config change time more than an hour ahead is
  refused (`CONFIG_TIME_IN_FUTURE`).
- Fan-out compares the sender's clock with the target's last write time: with
  clocks apart, "later wins" follows the clocks. A change queued after a
  `MESH_TIMEOUT` may already have been applied; applying it again is harmless
  (same values, same time).
- Hardening (after PR 12): the changes still waiting live in `storage.kv`
  (`jhin.mesh.outbox`, keyed by a number that only grows: the queue time, but
  always above the last key's, so the order changes were made in survives
  equal milliseconds and clock steps back); `mesh/outbox` stays the
  append-only history. A mesh change lists only the pending changes and never
  reads the stream; an outbox written before this is read once to build the
  pending set (retried if storage fails; a retry keeps the changes a failed
  attempt already took over, so each is pending once). Queueing writes the
  pending entry before `mesh.config.queued`, and no flush delivers it until
  that append is done; when the append fails, the entry is withdrawn and the
  caller gets the error, so a change is either queued
  with its history or not at all (a crash between the two writes leaves it
  pending without the `queued` event). A change undelivered
  `jhin.mesh.queueExpiryHours` after it was queued (default 720, `null` =
  never) ends as `mesh.config.expired` instead of waiting forever;
  `mesh.config.pending` lists what still waits (node, layer, section,
  `expiresAt`; never the values). Changes taken over from an older outbox keep
  their original queue time, so one queued longer ago than the expiry ends as
  `mesh.config.expired` on the first look after the upgrade, before any
  delivery attempt. Only an error of the delivery itself makes a change
  `mesh.config.failed`; when recording an outcome fails, the change stays
  pending and is delivered again later (harmless: same values, same time;
  the history then holds two outcome events for that id, and readers of
  `mesh/outbox` take the last one).
- `/mesh/join` rate limiting keys on `http.server`'s `clientAddress` (1.1): the
  socket's peer, or, when that peer is one of `jhin.http.trustProxy`
  (addresses or CIDR ranges, empty by default), the first untrusted hop of
  `jhin.http.forwardedHeader` (`x-forwarded-for` or RFC 7239 `forwarded`)
  read from the right. Forwarded headers from any other peer are ignored.
  Addresses come back in one spelling (canonical IPv6, IPv4-mapped IPv6 as
  IPv4), so one client has one bucket; an empty hop is `unknown`.

### PR 11 — Final end-to-end proof

Implements D47.

- Playwright e2e over three real node processes chained A–B–C: the client
  connected to A creates a thread on C and receives the fake reply; a second
  e2e shows two independent nodes in one client.
- **Done when:** both e2e tests pass in CI.

Implementation notes (PR 11):

- The web client reaches other nodes of a connected node's mesh: the
  sidebar lists them (from `mesh.nodes`, kept current by the `mesh` stream)
  under the connection, and a remote thread is read from the connection's
  copy (`mesh.open`) and driven with `mesh.call`. Routes carry the remote
  node (`#n=<connection>&r=<node>&t=<thread>`).
- "Add node" (`sidebar.actions`) opens the connect form, so one client holds
  several independent nodes (D8).
- `client.mesh@1` (`@jhin/client-api`, provided by the built-in
  `jhin.mesh-membership`) keeps one `mesh` subscription per connection,
  shared by every view (the sidebar and the main view today): the first
  subscriber opens it, the last one closes it, and a new client for the
  connection starts it over.
