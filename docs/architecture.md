# Jhin architecture

This document describes the runtime architecture of the Jhin host: what the
kernel is, how it boots, and the exact mechanics of class loading, HTTP
routing, streams and database ownership. It describes the code as it exists in
this repository (`sdk/`, `kernel/` and the plugin builds).

For writing plugins see [plugin-dev.md](plugin-dev.md); for the UI contract see
[sdui.md](sdui.md).

## 1. Three layers

1. **Kernel** (`kernel/`) — a generic plugin host. It knows six concepts only:
   plugin, manifest, exports/requires, class loader, service registry and
   lifecycle. It owns no product behaviour; `KernelPurityTest` enforces that no
   domain vocabulary appears in kernel sources.
2. **Plugins** (`plugins/`) — the entire product. Sessions, security, LLM
   providers, the agent loop, tools and every screen are jars loaded from the
   home plugins directory. Each plugin runs in its own class loader and
   extends the host through registries reached from `PluginContext`.
3. **HTML web client** (the `web/` resources of `jhin.ui`) — a thin
   vanilla-JS runtime the host serves. It hardcodes exactly one surface (the
   pairing fallback — the enroll form on 401/403) and one endpoint
   (`GET /_jhin/bootstrap`); everything else is server-rendered HTML over the
   primitive catalog (68 names at contract level 4, see [sdui.md](sdui.md)
   section 2.5).

A bare kernel is not a product: it answers only `GET /_jhin/health` and
`GET /_jhin/bootstrap` and reports an empty UI until plugins are installed.

## 2. Kernel concepts

The kernel contains exactly six concepts:

1. **plugin** — a jar carrying a manifest and one entry class, loaded into its
   own class loader and installed into the Jhin home plugins directory.
2. **manifest** — `jhin-plugin.json`, the declarative identity of the plugin,
   parsed and validated before any plugin class runs.
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

## 3. Extension surfaces

A plugin extends the host through five surfaces, all reached from
`PluginContext`, plus the service registry:

1. **HTTP routes** — `HttpRegistry.route(RouteSpec)`.
2. **HTTP filters and TLS** — `HttpRegistry.filter(FilterSpec)` and
   `HttpRegistry.tls(TlsProvider)`.
3. **Database** — `DbAccess.migrate(List<MigrationSpec>)` and transactional
   work units (`SqlWork`) over the shared schema.
4. **Streams** — `StreamRegistry` topics: publish, subscribe, SSE with a
   replay preamble (`SsePreamble`, `SseWriter`).
5. **CLI commands** — `CliRegistry.command(CliCommandSpec)`.

Plugin-to-plugin APIs are published as services through `ServiceRegistry`; the
providing plugin also exports the API package in its manifest so the consumer's
class loader can see the types.

## 4. Manifest model

Each plugin jar contains one manifest file named `jhin-plugin.json` (see
`plugins/example/src/main/resources/jhin-plugin.json` for a complete one).
Fields, validated by `PluginManifest.validate` before any plugin class runs:

- `id` — unique plugin id, `[a-z0-9][a-z0-9.-]{2,63}`;
- `version` — semver `x.y.z`;
- `apiVersion` — must equal `ApiVersion.CURRENT` (currently `1`);
- `name`, `description` — human-readable identity;
- `mainClass` — the fully qualified class implementing `JhinPlugin`;
- `exports` — package names made visible to dependants;
- `requires` — dependency list; each entry has `id`, `versionRange` (for
  example `>=0.2.0`) and `optional` (the plugin still loads when the
  dependency is missing).

The sole entry point is `JhinPlugin.start(PluginContext)`: it is called once,
before the HTTP server starts. The optional `stop()` method and the
`onStarted` / `onShutdown` hooks complete the lifecycle.

## 5. Runtime internals

### 5.1 Boot order

The boot sequence of `KernelBoot` runs in ten steps; steps 1–7 are covered by
`KernelBoot.open()`, steps 8–10 by `KernelBoot.serve(args)`. The CLI path
(`java -jar <kernel.jar> cli …`) runs the same sequence minus the web listener.

1. Resolve `JHIN_HOME` (default `~/.jhin`) and materialize its owner-only
   subdirectories (`data/`, `plugins/`, `keystore/`, `logs/`).
2. Load `config.json` and build the kernel's own configuration view from the
   `kernel` section (listener `address` and `port` live there). Each key
   resolves as environment variable > `config.json` > default: the port is
   read from `JHIN_KERNEL_PORT`, then `kernel.port`, then `8443`.
3. Open the shared SQLite file and its write queue.
4. Apply the kernel migrations (the `_jhin_*` tables).
5. Seed the bundled plugin jars into the home plugin directory (decision table
   in section 5.5).
6. Scan `plugins/*.jar` and parse their manifests (candidate list).
7. Start every plugin in dependency order with failures isolated and
   cascade-skipped: validate manifests, resolve the dependency graph, create a
   class loader per plugin, call `start(PluginContext)`. A failed plugin is
   recorded in the load report, never fatal to the host.
8. Check TLS material and filters: when no `TlsProvider` was accepted the
   listener speaks plain HTTP; when no filter is registered the host logs
   `SECURITY: no HTTP filter registered — this server is fully open …`.
9. Start the web server on the configured address and port (default
   `0.0.0.0:8443`; a `--server.port` argument overrides the resolved port)
   with the collected registries supplied as pre-built singletons.
10. Run the `onStarted` hooks once the listener is up. On shutdown, stop
    everything in reverse order: `onShutdown` hooks and `stop()` in reverse
    load order, then the stream registry, then the database with its write
    queue.

### 5.2 Class loading and visibility

Every plugin jar is loaded by its own `PluginClassLoader`. A class name
resolves in five steps (see the `PluginClassLoader` class comment):

1. already loaded through this loader → return it;
2. a name under one of the shared prefixes → the kernel loader;
3. a package exported by a direct or transitive dependency → the loaders of
   those dependencies, consulted in topological order;
4. this plugin's own jar;
5. otherwise a `ClassNotFoundException` whose text names the plugin, the class
   and every package the plugin can see.

The shared prefixes are `com.astroreen.jhin.sdk.`, `java.`, `javax.`,
`jakarta.`, `org.slf4j.` and `com.fasterxml.jackson.`. Nothing else ever falls
through to the kernel loader, so a plugin can never reach kernel internals.

**Sub-package export rule.** A package matches an export when it equals the
export or is one of its sub-packages: exporting `com.astroreen.jhin.plugin.sessions.api`
covers `com.astroreen.jhin.plugin.sessions.api` and anything below it
(`…api.internal`), but not the parent `com.astroreen.jhin.plugin.sessions` and
not sibling packages. Resources follow the same rules as classes.

Worked example — the visibility of `jhin.sdk`, `jhin.sessions` and `jhin.agent`
as loaded from their shipped manifests:

```text
jhin.sessions (jar: jhin-plugin-sessions.jar)
  exports: [com.astroreen.jhin.plugin.sessions.api]
  requires: []

jhin.llm (jar: jhin-plugin-llm.jar)
  exports: [com.astroreen.jhin.plugin.llm.api, dev.langchain4j.* (7 packages)]
  requires: []

jhin.agent (jar: jhin-plugin-agent.jar)
  exports: [com.astroreen.jhin.plugin.agent.api]
  requires: [jhin.sessions >=0.2.0, jhin.llm >=0.2.0]

Request: jhin.agent loads com.astroreen.jhin.plugin.sessions.api.SessionStore
  step 2: not a shared name (does not start with a shared prefix) -> no
  step 3: jhin.sessions is a (transitive) dependency and exports
          com.astroreen.jhin.plugin.sessions.api, which covers the package of
          SessionStore -> load from the jhin.sessions loader -> OK

Request: jhin.agent loads com.astroreen.jhin.plugin.sessions.SessionStoreImpl
  step 3: jhin.sessions does NOT export com.astroreen.jhin.plugin.sessions
          (the export covers the api package and its sub-packages only)
  step 4: not in jhin.agent's own jar
  step 5: ClassNotFoundException:
          "plugin jhin.agent cannot see com.astroreen.jhin.plugin.sessions.SessionStoreImpl;
           visible exports: com.astroreen.jhin.plugin.llm.api,
           com.astroreen.jhin.plugin.sessions.api, dev.langchain4j.agent.tool, …"
          (the list is the union of the DEPENDENCIES' exports, sorted)

Request: jhin.agent loads com.astroreen.jhin.sdk.PluginContext
  step 2: name starts with "com.astroreen.jhin.sdk." -> kernel loader -> OK
          (exactly one PluginContext class exists, shared by all plugins)

Request: jhin.agent loads java.util.List
  step 2: name starts with "java." -> kernel loader -> OK
```

**Three practical causes of a `ClassNotFoundException`:**

1. **Wrong loader — non-exported package.** The class exists in a dependency
   jar, but its package is not covered by any export of that dependency. The
   fix is on the provider side: add the package (or a parent package, since
   exports cover sub-packages) to the provider's manifest `exports`. The
   failure text always lists the visible exports, so the gap is readable from
   the message alone.
2. **Shared-prefix miss.** The name is not under a shared prefix and does not
   live in an exported dependency package: e.g. a plugin trying to use a
   kernel-internal class, another plugin's implementation class, or a library
   class that is only on the kernel classpath. The loader never falls through
   to the kernel loader for such names. Fix: bundle the library in your own jar
   (the fat-jar task does this for runtime dependencies), or depend on the
   plugin that exports the API package.
3. **Own-jar shadowing.** The plugin's own jar is consulted *last*, after the
   dependency exports, and the fat-jar task deliberately excludes the parts the
   kernel already provides (`jhin-sdk*`, `slf4j-*`, `jackson-*`). A type you
   expected your own jar to supply — but which was excluded as a
   kernel-provided artifact, or was only a `compileOnly` dependency — is then
   nowhere to be found and fails with the same CNFE. The mirror image is also
   real: a class you *did* bundle under a package some dependency exports is
   answered by the dependency copy first, never by your own.

### 5.3 Routes, filters and TLS

**Route table.** Routes are registered per exact `(method, path template)`
pair. Path templates take at most one `{name}` placeholder per segment and no
wildcards (`RouteSpec` normalizes and validates them). Registration rules:

- a duplicate non-fallback `(method, path)` is refused with
  `route conflict: <method> <path> already owned by <owner>`;
- a *fallback* registration (the kernel's provisional `/_jhin/health` and
  `/_jhin/bootstrap`, installed before anything else loads) is replaced
  silently by the next route on the same pair — a plugin route always
  supersedes the fallback it shadows.

**Matching (`RouteMatcher`).** Candidates are templates of the same method and
segment count. Matching is exact on segment count and prefers a **literal
template segment over a `{param}` one at every position**, scanning left to
right: the first segment where two candidates disagree decides between them.
When the literal branch dead-ends deeper down, the param branch is tried.
Templates indistinguishable in shape resolve in registration order. Example:
with `/sessions/{id}` and `/sessions/new` registered, `GET /sessions/new`
selects the literal route and `GET /abc` selects the param route.

**404 / 405.** When no route matches the method but the path matches a route of
another method, the resolution is `METHOD_NOT_ALLOWED`, answered as `405` with
body `{"error":"method_not_allowed","message":"no route allows <METHOD> <path>"}`.
A path matching nothing is `404` with
`{"error":"not_found","message":"no plugin serves <METHOD> <path>"}`. Any
uncaught failure on the dispatch path is logged with its stack trace and
answered as `500` naming only the exception class.

**Filters.** Filters run around the matched route handler in ascending
`FilterSpec.order`, ties broken by the id of the registering plugin. Only
filters whose `pathPrefix` matches the request path take part (`/` selects
all; any other prefix is a `startsWith` match). The chain is built per request:
a filter continues via `FilterChain.proceed` (optionally with a rewritten
request); returning without calling `proceed` short-circuits and its response
is sent as-is; a filter that throws propagates to the caller and becomes a
`500`.

**TLS.** `HttpRegistry.tls(TlsProvider)` is first-wins: the first accepted
provider supplies the key store and password at server startup, later
registrations are ignored. With no provider the listener speaks plain HTTP and
logs `no TLS material registered; the listener speaks plain HTTP`.

**OPTIONS / CORS.** `OPTIONS` is answered before anything else runs with a
permissive pre-flight: `204` and `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers: *`,
`Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS`. The web client
is served same-origin and does not depend on it; the pre-flight stays
permissive for tooling that talks to the host from another origin.

### 5.4 Streams and the preamble race

A stream topic fans out published `StreamEvent`s to every subscriber without
ever blocking the publisher; slow SSE connections buffer and report overflow
instead of applying back-pressure. A topic is dropped as soon as it has no
listeners.

The SSE endpoint (`StreamRegistry.sse(topic, preamble)`) must replay history
and then live-tail without gaps and without duplicates. The kernel resolves
this with a fixed handshake — the **preamble race** is closed by construction:

1. **subscribe + buffer** — the kernel subscribes to the topic and starts
   buffering every live event *first*;
2. **preamble** — it then runs `SsePreamble.write(SseWriter)`, where the
   plugin replays its own backlog from storage;
3. **flush + tail** — only then is the buffer flushed and the live tail begun.

Because live events can already be in the buffer while the preamble replays the
same rows from the database, the plugin **must de-duplicate by its own
monotonic id**. The sessions event route and the UI session stream do this by
sequence number: an observer records the `seq` of every live event, and the
replay skips any row whose `seq` was already observed live (the live copy
wins), so each sequence number is written at most once per connection. The
kernel additionally sends a `:heartbeat` comment every 15 s and closes the
connection on client disconnect.

### 5.5 Database ownership and bundled seeding

**One schema, one write lane.** The kernel owns the shared SQLite file and its
`WriteQueue`: a single daemon thread (`jhin-db-writer`) executes every write
one at a time, in submission order, so callers never collide and never observe
locking errors. `DbAccess.write(SqlWork)` submits to that queue and blocks
until the task completes; `DbAccess.read(SqlWork)` runs concurrently — many
reads may run at the same time and must not modify data.

**Table ownership.** Every table and index a migration creates must carry the
prefix of the owning plugin: the plugin id with every character outside
`[a-z0-9]` replaced by `_` plus a trailing `_` (`jhin.sessions` →
`jhin_sessions_`, exposed as `DbAccess.tablePrefix()`). `MigrationGuard` scans
each migration's `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX`
targets (case-insensitive, optional `IF NOT EXISTS`, optional quoting) and
refuses the migration before anything is applied when a target does not start
with the required prefix. Applied versions are recorded and skipped on later
starts (migrations are idempotent and strictly increasing in version).

**Bundled plugin seeding.** On every start the kernel copies the bundled jars
of the distribution (`JHIN_BUNDLED_PLUGINS` when set, else the
`plugins-default` directory next to the running jar) into the home plugin
directory. One row per jar in `_jhin_seeded_plugins` (`jar_name`, `sha256`)
makes the run idempotent. Decision table for each bundled jar, given the
recorded state (if any) and the installed copy:

| # | Recorded state | Installed copy | Action |
|---|----------------|----------------|--------|
| 1 | none | absent | copy the jar, record its SHA-256 (`seeded …`) |
| 2 | none | present (a user-placed file of that name) | skip with `WARN`: a file of that name is already in the plugin directory |
| 3 | present | absent (the user deleted the copy) | skip: the seeded copy was removed and stays removed — deletion is final |
| 4 | present, equals bundled SHA-256 | present, unchanged | skip: already seeded and unchanged |
| 5 | present, differs from bundled SHA-256 | present, still matches the recorded digest (untouched copy) | overwrite the copy and update the record (`upgraded …`) — clean upgrade |
| 6 | present, differs from bundled SHA-256 | present, modified by the user (digest ≠ recorded) | skip with `WARN`: the seeded copy was modified by the user |

Every decision is logged on one line and every record write goes through the
shared write lane. A jar that cannot be read or copied is logged and skipped; a
database failure aborts the run.

### 5.6 Scheduler seam

`ctx.sched()` hands plugins the host scheduler (`SchedulerRegistry`,
implemented by `kernel/…/sched/SchedulerRegistryImpl.java`) — one shared
`ScheduledExecutorService` for the whole host (daemon threads `jhin-sched-1`
and `jhin-sched-2`; the pool size is a host constant):

- `schedule(TaskSpec)` runs `TaskSpec.oneShot(name, delayMs, run)` or
  `TaskSpec.periodic(name, initialDelayMs, periodMs, run)`; scheduling a name
  that already exists cancels the previous task and installs the new one.
- `cancel(name)` is idempotent; `names()` lists the live task names.
- A throwing periodic run stays scheduled; a one-shot that throws is simply
  done.
- Shutdown is bounded: the scheduler stops accepting work and the kernel joins
  it for at most 5 seconds before moving on to the rest of the shutdown
  sequence, interrupting if needed. Nothing scheduled survives a restart;
  durable state belongs in the database.

## 6. UI and client internals

### 6.1 Design-token layer

Every visual constant of the client is a named token, never a literal. The
server side owns the vocabulary in `plugins/ui-kit/.../UiTokens.java`: the
typed families `color` (the 56 semantic `--color-*` aliases), `contrast` (the
`--contrast-*` foreground indirection), `radius`, `text`, `font`, `space`,
`layout`, `glass`, `motion`, `shadow`, `scroll` and `z`, each with a
`$family.key` reference helper that rejects unknown keys at build time.
`TokenDefaults.java` supplies the fallback values and `BootstrapRoute` emits
the whole `tokens` block in the bootstrap payload ([sdui.md](sdui.md)
section 1).

The web client renders from the same vocabulary: node props reference tokens
by name as `$token` strings, `TokenCss.root` emits the whole surface as CSS
variables in the shell's inline token CSS and every `$…` reference becomes a
`var(--family-key)` at render time ([sdui.md](sdui.md) section 9.4).
`app.css` styles from those variables alone — no literal colors or paddings
in the runtime.

### 6.2 Theme catalogue and palette generator

`plugins/ui-kit/.../ThemeCatalog.java` holds the six selectable themes: the
five t3code built-ins (`t3-chat`, `grove`, `ocean`, `ember`, `iris`) plus the
`jhin` identity theme. Each entry carries a light and a dark canvas/accent
seed pair (the upstream `themePalettes.ts` roles) and the per-theme
`--stage-art-*` backdrop metadata; `jhin` keeps the pre-catalogue
`#16161e` / `#7E57C2` seeds so selecting it reproduces the original palette.
The selected id persists as `themeId` (default `t3-chat`) in the `jhin.ui`
settings store (the plugin data directory).

`plugins/ui-kit/.../PaletteGen.java` (with `Oklch.java`) is the two-seed
generator: given an appearance and a canvas/accent pair it derives the full
semantic colour surface — the perceptual lightness ladder, WCAG-solved
foregrounds (≥ 7:1), the +50° companion action colour and the status blends —
as 8-bit hex, the wire format of the token layer. It is the single port: the
web runtime performs no palette math ([sdui.md](sdui.md) section 9.4).

### 6.3 Decorative-surface pattern

A decorative control is a node whose `action` is an inline directive list
(`{client: [setState, patch, setScreen, dialog, toast]}`) resolved entirely
client-side, with no server round-trip and no database write. Every such
interactive node MUST carry the universal `demo: true` prop
([sdui.md](sdui.md) section 2.1): the rendered node carries the shared
`data-jhin-demo` marker and the web client paints the disabled-affordance — a
small corner `preview` badge plus the tooltip
`Preview only — not available in this build` (`app.css`) — so nothing
decorative looks silently real. The server-side `DemoMarkerSweepTest` enforces
the marking across every decorative route; real screens must never carry
`demo` on a real action.

### 6.4 The `Ui` builder lattice

`plugins/ui-kit/` is API-only: `UiNode` (the JSON-shaped node model) and the
fluent `Ui` builder over the primitive catalog. Builders are composed through
a small capability lattice — `has` plus the mixins `HasBox`, `HasText`,
`HasFlex`, `HasInteraction`, `HasChildren` and `HasItems` — so each builder
exposes exactly the prop surface its primitives accept, and every setter
funnels through one `PropSink` into the node's JSON map. `UiEnums` validates
enum-valued props at build time and `UiTokens` holds the token names the
builder may emit. `UiConformanceTest` keeps the emittable keys and the
[sdui.md](sdui.md) tables in lock-step (section 2.6).

### 6.5 Versioned client store

The web runtime's persisted state is an envelope —
`{schema, app, writtenAt, data}` — over its `localStorage` keys (the `jhin.*`
set of [sdui.md](sdui.md) section 8). Migrations run automatically at
startup: `StoreMigration` steps under the six `MigrationRunner` rules
documented in [updates.md](updates.md). A value whose migration throws is
copied to `migration.quarantine:<key>:<schema>` and recorded in
`migration.quarantine` instead of being dropped — downgrades never destroy
data. The version gate is server-driven: `BootstrapRoute` names the
client-owned `version_gate` entry when the caller's advertised store schema is
below `contract.minSchema`, so a stale store shows the "update required"
chrome instead of product screens.

### 6.6 Keyboard layer

The command vocabulary lives server-side: `KeybindCatalog` holds the fixed set
of 25 command ids and `DefaultKeymap` the default chords, which travel in the
bootstrap `keymap` array; the caller's overrides travel back per request in
the `X-Jhin-Keybindings` header ([sdui.md](sdui.md) section 8). The web
runtime (`app.js`) turns key events into named commands, merges the user
overrides from its `jhin.keybindings` store (last match wins) and dispatches
the matching action.

### 6.7 Gallery and golden harness

The ui-kit `GalleryDump` probe builds a basic and a prop-heavy fixture for
every primitive through the real `Ui` builders and reports the per-primitive
coverage table (`build/gallery/coverage.txt`); `UiRegressionTest` pins the
JSON wire shape of one representative node per builder against the committed
fixtures under `plugins/ui-kit/src/test/resources/regression/`, so any
primitive, prop or token change surfaces as a fixture diff.

## 7. Security model notes

- HTTP-level guarding is a filter's job (`jhin.security` registers the bearer
  filter and the TLS keystore generator). With no filter registered the host
  warns at startup that the server is fully open.
- OS-level isolation (uid, nftables) is out of scope for this MVP; the product
  enforces confinement at the application layer only.
- Stored API keys are not encrypted at rest in this MVP.

## 8. What the kernel deliberately does not do

- No worker protocol, no remote tool execution, no multi-instance sync.
- No hot-swap class reload inside a running JVM (`jhin.reload` restarts the
  host under the deploy restart loop instead).
- No OSGi/PF4J; the plugin loader is the kernel's own.
- No domain words in kernel sources (enforced by `KernelPurityTest`).
