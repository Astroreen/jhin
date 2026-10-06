# Jhin — AGENTS.md

## What Jhin is

Jhin is a self-hosted coding agent. This repository contains almost no product
code: the kernel is a plugin aggregator plus an SDK, and the product is
entirely plugins. One host process loads plugin jars from a local directory and
executes everything itself; the Flutter frontend is a thin server-driven-UI
renderer shared by Android, Linux desktop and Web.

## Everything is a plugin

Sessions, security, LLM providers, the agent loop, tools and every screen are
plugins. Nothing product-shaped lives in the kernel or in the SDK. Every line
is written so that a plugin can adjust the behaviour: product features arrive
as plugin jars, not as kernel patches.

- The UI is server-driven: plugins describe screens as JSON, the client renders
  them with its own fixed registry of primitives.
- Behaviour is contributed through registries (routes, filters, migrations,
  streams, CLI commands, services), never hardwired into the host.
- A bare kernel is not a product: it answers its own health and bootstrap
  endpoints and renders an empty state until plugins are installed.

## Kernel concepts

The kernel knows exactly six concepts:

1. **plugin** — a jar carrying a manifest and one entry class, loaded into its
   own class loader; installed into the Jhin home plugins directory.
2. **manifest** — the declarative identity of a plugin (see below), parsed and
   validated before any plugin class runs.
3. **exports / requires** — the visibility and dependency edges between
   plugins: `exports` are package names visible to dependants, `requires` are
   dependency entries with version ranges and an `optional` flag.
4. **class loader** — one class loader per plugin; SDK types are shared, and
   only exported packages of a plugin's dependencies are visible to it.
5. **service registry** — the runtime channel for plugin-to-plugin contracts:
   a plugin publishes typed services, others look them up.
6. **lifecycle** — scan, parse, validate, resolve the dependency graph, then
   `start()` every plugin before the HTTP server exists; `onStarted` and
   `onShutdown` hooks for anything needing a live server; `stop()` runs in
   reverse load order on shutdown.

The kernel contains no domain words: no tool, session, agent, message,
provider, run, account, device, enroll, prompt, llm, workdir, hub, worker or
role identifiers in kernel sources, and no domain libraries on the kernel
classpath. This is enforced mechanically by
`kernel/src/test/java/com/astroreen/jhin/kernel/KernelPurityTest.java`.

## Manifest model

Each plugin jar contains one manifest file named jhin-plugin.json (see
`plugins/example/src/main/resources/jhin-plugin.json` for a complete one).
Fields:

- `id` — unique plugin id (lowercase, dotted);
- `version` — semver of the plugin;
- `apiVersion` — must equal the SDK api version (currently `1`);
- `name`, `description` — human-readable identity;
- `mainClass` — the fully qualified class implementing `JhinPlugin`;
- `exports` — package names made visible to dependants;
- `requires` — dependency list; each entry has `id`, `versionRange` (for
  example `>=0.2.0`) and `optional` (the plugin still loads when the
  dependency is missing).

The sole entry point is `JhinPlugin.start(PluginContext)` (see
`sdk/src/main/java/com/astroreen/jhin/sdk/JhinPlugin.java`): it is called once,
before the HTTP server starts, and everything a plugin may touch — registries,
config, data directory, logger — arrives through the `PluginContext`. The
optional `stop()` method and the `onStarted` / `onShutdown` hooks complete the
lifecycle.

## Extension surfaces

A plugin extends the host through five surfaces, all reached from
`PluginContext`, plus the service registry:

1. **HTTP routes** — register handlers with `HttpRegistry`.
2. **HTTP filters and TLS** — filters with an order and a path prefix
   (`HttpFilter`, `FilterSpec`), and a `TlsProvider` for the HTTPS keystore.
3. **Database** — versioned migrations (`MigrationSpec`) and transactional
   work (`SqlWork`) over the shared schema (`DbAccess`).
4. **Streams** — server-sent event topics: publish, subscribe, replay
   (`StreamRegistry`, `SseWriter`).
5. **CLI commands** — host subcommands with typed arguments
   (`CliRegistry`, `CliCommandSpec`).

Plugin-to-plugin APIs are published as services through `ServiceRegistry`:
a plugin exports an API package in its manifest and a service instance at
runtime; consumers depend on the plugin and look the service up.

## Frontend rule

The Flutter client hardcodes exactly one screen — the client-owned
server-profile surface (add-server and profile switching) — and one endpoint:
the bootstrap fetch (`GET /_jhin/bootstrap`). Everything else is server-driven
UI over the primitive catalog: since contract level 3 the primitives are a
catalog of 68 (layout, text, controls, surfaces, data, nav — see
`docs/sdui.md` §2.5), no longer a fixed list of 25. An unknown primitive
renders a placeholder card; the client never crashes on server content. The
kernel itself owns only two endpoints — `GET /_jhin/health` and
`GET /_jhin/bootstrap` — with a bootstrap fallback that any plugin may
override.

Bootstrap negotiation: the payload carries
`contract {api: 3, minApi: 2, schema: 4, minSchema: 3}` and every client
request advertises `X-Jhin-Client: api=…; version=…; schema=…; caps=…`
(`docs/sdui.md` §1, §6). Release builds of the client must pass
`--no-tree-shake-icons`: `frontend/lib/design/icon_registry.dart` resolves
8825 `IconData` lookups dynamically, so the icon tree-shaker cannot see which
glyphs are used and would strip them.

## Rules

1. **Zero external binaries in tools** — everything is pure Java; no fd, no
   ripgrep, no shelling out for search or file work.
2. **Zero manual installs for the user** — gradle wrapper plus a fat jar; the
   product never requires nix or any hand-installed toolchain.
3. **Only existing published dependencies** — LangChain4j, the MCP SDK and
   other shipped libraries; JSON and SSE only, never a custom binary protocol.
4. **No domain words in the kernel** — product concepts live in plugins; the
   kernel is a generic host (enforced by `KernelPurityTest`).
5. **Everything in English** — comments, documentation and commit messages.

## Repository layout

The old v1 backend is gone. The repository is a composite Gradle build:

```
├── AGENTS.md                this file
├── README.md                user-facing overview
├── settings.gradle          composite build: sdk, kernel, 12 plugins
├── build.gradle             root aggregate
├── gradlew gradlew.bat      Gradle wrapper
├── devenv.nix               dev shell (product itself never requires nix)
├── sdk/                     the plugin contract (plain Java 21, no domain)
├── kernel/                  plugin aggregator: loader, registries, host
├── plugins/
│   ├── sessions/            jhin.sessions
│   ├── security/            jhin.security
│   ├── llm/                 jhin.llm
│   ├── llm-builtin/         jhin.llm-builtin
│   ├── agent/               jhin.agent
│   ├── tools-builtin/       jhin.tools-builtin
│   ├── mcp/                 jhin.mcp
│   ├── ui-kit/              jhin.ui-kit
│   ├── ui-default/          jhin.ui
│   ├── reload/              jhin.reload
│   ├── qa-mock-llm/         jhin.qa-mock-llm
│   └── example/             jhin.example
├── frontend/                Flutter SDUI runtime (Android / Linux / Web)
├── deploy/                  restart loop, systemd example, run notes
├── scripts/qa/              QA scripts
├── docs/                    architecture, plugin development, SDUI (T42), updates, VSCode troubleshooting
└── .opencode/               plugin-authoring skill and command (T43)
```

## Plugin catalogue

- `plugins/sessions/` (`jhin.sessions`) — session store and append-only event
  log with gap-free per-session sequences.
- `plugins/security/` (`jhin.security`) — accounts, device tokens and
  single-use enrollment codes; bearer filter, TLS keystore, CLI.
- `plugins/llm/` (`jhin.llm`) — LangChain4j runtime, provider factory SPI and
  the provider registry with CRUD routes.
- `plugins/llm-builtin/` (`jhin.llm-builtin`) — the three deletable built-in
  provider factories: anthropic, openai and gemini.
- `plugins/agent/` (`jhin.agent`) — agent loop, prompt assembly and run
  lifecycle; exports the tool and prompt SPI.
- `plugins/tools-builtin/` (`jhin.tools-builtin`) — the pure-Java tool set
  with a path sandbox and gitignore-aware file walking.
- `plugins/mcp/` (`jhin.mcp`) — Model Context Protocol client for the
  user-declared servers; contributes remote tools to the agent plugin.
- `plugins/ui-kit/` (`jhin.ui-kit`) — API-only UI building blocks: `UiNode`
  and the fluent `Ui` builder over the primitive catalog.
- `plugins/ui-default/` (`jhin.ui`) — default screens as JSON, bootstrap
  owner, action dispatch and the session stream endpoint.
- `plugins/reload/` (`jhin.reload`) — `POST /admin/reload` restarts the host
  under the deploy restart loop.
- `plugins/qa-mock-llm/` (`jhin.qa-mock-llm`) — deterministic mock LLM
  factories for tests and QA (scripted replies, title and failure scripts);
  never ships in the release bundle.
- `plugins/example/` (`jhin.example`) — the copy-paste template demonstrating
  every extension surface; start from `plugins/example/README.md`.

## Not in this MVP

- Worker protocol, remote tool execution, multi-instance sync
- Hot-swap class reload inside a running JVM
- OSGi, PF4J or other plugin frameworks (the loader is the kernel's own)
- MCP server side (the MCP plugin is a client only)
- Approval-gate UI on tool calls
- Session compaction or branching (overflow fails; start a new session)
- Windows and iOS builds (code is compatible; build targets are not set up)
- NixOS module (deploy is a generic systemd example plus a jar)
- OS-level account isolation (uid, nftables); app-layer only
- Custom binary protocol (JSON + SSE only)
- Encryption of stored API keys
