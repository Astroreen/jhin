# Jhin plugin development

A plugin is one jar with a `jhin-plugin.json` manifest and one entry class
implementing `JhinPlugin`. The host loads it into its own class loader, calls
`start(PluginContext)` once before the HTTP server starts, and runs everything
the plugin registered from then on. This guide walks through the workflow, the
full `PluginContext` surface, one working example per extension surface, the
plugin-to-plugin recipes, chain semantics of the agent SPI, troubleshooting and
packaging.

Architecture background lives in [architecture.md](architecture.md); the UI
contract in [sdui.md](sdui.md). A complete annotated template is
`plugins/example/` (`plugins/example/README.md` explains how to observe every
surface); snippets copied verbatim from there are referenced by path and the
fences below carry the compilable minimal variants.

## 1. Quickstart

1. **Copy the template.** Duplicate `plugins/example/` as `plugins/<yours>/`,
   rename the Gradle module and the Java package, and register the build in
   `settings.gradle` (`includeBuild('plugins/<yours>') { name =
   'jhin-plugin-<yours>' }`).
2. **Edit the manifest** `src/main/resources/jhin-plugin.json`: set `id`,
   `version`, `name`, `description`, `mainClass`, `exports` and `requires`
   (field rules in section 7).
3. **Implement `JhinPlugin.start`** and register your surfaces (section 3).
4. **Build the jar:**

   ```bash
   ./gradlew :jhin-plugin-<yours>:jar
   ```

5. **Install and restart:**

   ```bash
   cp plugins/<yours>/build/libs/*.jar ~/.jhin/plugins/
   ```

   then restart the host (or `POST /admin/reload` when `jhin.reload` is
   loaded — see `deploy/run.sh` for the restart loop). The kernel also seeds
   bundled jars from `JHIN_BUNDLED_PLUGINS` / `plugins-default/`; copying the
   jar into `$JHIN_HOME/plugins/` yourself is the user-install path.

6. **Verify** with `GET /_jhin/health`: the `plugins` array lists loaded
   plugins and `failed` lists load failures with reasons.

## 2. PluginContext reference

`JhinPlugin.start(PluginContext ctx)` receives the context once; it stays valid
for the whole plugin lifetime. All thirteen accessors, in the order they appear
in `sdk/src/main/java/com/astroreen/jhin/sdk/PluginContext.java`:

| Method | Returns | What it is for |
|--------|---------|----------------|
| `manifest()` | `PluginManifest` | this plugin's id, version, declared exports |
| `log()` | `org.slf4j.Logger` | this plugin's logger, already named after the plugin id; never configure it yourself |
| `dataDir()` | `java.nio.file.Path` | per-plugin writable directory `JHIN_HOME/data/<id>/`, created `0700` |
| `config()` | `ConfigView` | this plugin's config section; resolution order per key: env `JHIN_<ID>_<KEY>` → `config.json` `<id>` object → caller default |
| `services()` | `ServiceRegistry` | cross-plugin service registry: `publish` / `find` / `findAll` |
| `http()` | `HttpRegistry` | routes, filters and TLS registration |
| `db()` | `DbAccess` | migrations plus `read` / `write` work units over the shared SQLite schema |
| `streams()` | `StreamRegistry` | publish events, subscribe, serve SSE with a replay preamble |
| `sched()` | `SchedulerRegistry` | one-shot and periodic work on the host executor; see section 3.6 |
| `cli()` | `CliRegistry` | host subcommands (`java -jar <kernel.jar> cli <name> …`) |
| `kernel()` | `KernelInfo` | host facts: versions, home, loaded plugins |
| `onStarted(Runnable)` | `void` | hook running once the HTTP server is listening |
| `onShutdown(Runnable)` | `void` | hook running on graceful shutdown |

Everything must be registered inside `start()`; nothing may be registered after
the server is listening. Use `onStarted` for work that needs a live server
(bind-time publishing, warm-up calls) and `onShutdown` for releasing resources.

## 3. One working example per surface

### 3.1 HTTP route

```java
package com.example.jhin;

import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.Map;

public final class RouteExample {

    public static void register(PluginContext ctx) {
        ctx.http().route(new RouteSpec("GET", "/greet/{name}", RouteExample::greet));
    }

    static HttpResponse greet(HttpRequest req) throws Exception {
        String name = req.pathParams().getOrDefault("name", "world");
        return HttpResponse.json(200, Map.of("greeting", "hello, " + name));
    }
}
```

Path templates take at most one `{name}` placeholder per segment and no
wildcards; `req.pathParams()` carries the captures, `req.query()` the
multi-valued query parameters. Duplicate `(method, path)` registrations are
refused with `route conflict: … already owned by …`; the kernel's
`/_jhin/health` and `/_jhin/bootstrap` fallbacks are replaced silently.

### 3.2 Filter and TLS

```java
package com.example.jhin;

import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.FilterSpec;
import com.astroreen.jhin.sdk.http.HttpFilter;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.TlsProvider;
import java.security.KeyStore;

public final class FilterTlsExample {

    public static void register(PluginContext ctx, KeyStore keyStore, char[] password) {
        HttpFilter requireToken = (req, chain) -> {
            String authorization = req.headers().get("authorization");
            if (authorization == null || authorization.isBlank()) {
                return HttpResponse.error(401, "unauthorized", "missing Authorization header");
            }
            req.setAttribute("authorization", authorization);
            return chain.proceed(req);
        };
        ctx.http().filter(new FilterSpec("require-token", "/", 10, requireToken));
        ctx.http().tls(new TlsProvider() {
            @Override
            public KeyStore keyStore() {
                return keyStore;
            }

            @Override
            public char[] keyStorePassword() {
                return password;
            }
        });
    }
}
```

Filters run in ascending `order` (ties broken by plugin id) around the matched
route handler; `/` matches every path, any other `pathPrefix` selects paths
starting with it. Returning without `chain.proceed` short-circuits the chain.
TLS is first-wins: the first accepted `TlsProvider` supplies the key store at
server startup, later registrations are ignored; with none the listener speaks
plain HTTP.

### 3.3 Migration and SqlWork

```java
package com.example.jhin;

import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

public final class MigrationExample {

    public static void register(PluginContext ctx) {
        ctx.db().migrate(List.of(new MigrationSpec(1,
                "CREATE TABLE IF NOT EXISTS " + table(ctx)
                        + " (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL)")));
    }

    public static void addNote(PluginContext ctx, String note) {
        ctx.db().write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO " + table(ctx) + " (note) VALUES (?)")) {
                insert.setString(1, note);
                insert.executeUpdate();
            }
            return null;
        });
    }

    public static List<String> notes(PluginContext ctx) {
        return ctx.db().read(connection -> {
            List<String> notes = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT note FROM " + table(ctx) + " ORDER BY id");
                    ResultSet rows = query.executeQuery()) {
                while (rows.next()) {
                    notes.add(rows.getString(1));
                }
            }
            return notes;
        });
    }

    private static String table(PluginContext ctx) {
        return ctx.db().tablePrefix() + "notes";
    }
}
```

Versions start at `1` and increase strictly across the migration list; applied
versions are recorded and skipped on later starts. Every created table and
index **must** start with `db().tablePrefix()` (the plugin id with every
character outside `[a-z0-9]` replaced by `_` plus a trailing `_`); the kernel
refuses the migration otherwise. `write` runs on the kernel's single write
lane (serialized, submission order); `read` runs concurrently and must not
modify data.

### 3.4 Stream with preamble de-duplication

```java
package com.example.jhin;

import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.Subscription;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public final class StreamPreambleExample {

    static final String TOPIC = "demo/events";

    private final List<Map<String, Object>> history =
            java.util.Collections.synchronizedList(new java.util.ArrayList<>());

    public void publish(PluginContext ctx, long seq, String text) {
        Map<String, Object> row = Map.of("seq", seq, "text", text);
        history.add(row);
        ctx.streams().publish(TOPIC, new StreamEvent("note", row));
    }

    public HttpResponse stream(PluginContext ctx) {
        Set<Long> live = ConcurrentHashMap.newKeySet();
        Subscription observed = ctx.streams().subscribe(TOPIC, event -> {
            if (event.payload() instanceof Map<?, ?> body
                    && body.get("seq") instanceof Number seq) {
                live.add(seq.longValue());
            }
        });
        return ctx.streams().sse(TOPIC, writer -> {
            try {
                for (Map<String, Object> row : List.copyOf(history)) {
                    long seq = ((Number) row.get("seq")).longValue();
                    if (live.add(seq)) {
                        writer.event("note", row);
                    }
                }
            } finally {
                observed.close();
            }
        });
    }
}
```

The kernel subscribes and starts buffering live events **first**, then runs the
preamble (your replay), then flushes the buffer and live-tails — so a live
event may already be buffered while your preamble replays the same row from
storage. **De-duplicate by your own monotonic id** (here: `seq`); the live copy
wins and each id is written at most once per connection. The kernel sends a
`:heartbeat` comment every 15 s and closes the connection on client disconnect.

### 3.5 CLI command

```java
package com.example.jhin;

import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;

public final class CliExample {

    public static void register(PluginContext ctx) {
        ctx.cli().command(new CliCommandSpec("greet", "greet [name]",
                "prints a greeting", (args, out, err) -> {
                    out.println("hello, " + (args.isEmpty() ? "world" : args.get(0)));
                    return 0;
                }));
    }
}
```

Dispatched as `java -jar <kernel.jar> cli greet world`: plugins are loaded and
`start()` runs, but the HTTP server never boots; the handler's return value is
the process exit code.

### 3.6 Scheduled work

`ctx.sched()` hands your plugin the host scheduler: one shared executor for
every plugin, created at host start (two daemon threads named
`jhin-sched-1`/`jhin-sched-2`; the pool size is a host constant). Tasks are
described by `com.astroreen.jhin.sdk.sched.TaskSpec` and identified by a name
that is unique per host.

```java
package com.example.jhin;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.sched.TaskSpec;

public final class SchedExample implements JhinPlugin {

    @Override
    public void start(PluginContext ctx) {
        // one-shot: runs exactly once, 500 ms from now
        ctx.sched().schedule(TaskSpec.oneShot("warmup", 500, this::warmUp));

        // periodic: first run after 1 s, then every 30 s
        ctx.sched().schedule(TaskSpec.periodic("sweep", 1_000, 30_000, this::sweep));
    }

    private void warmUp() { /* deferred work */ }

    private void sweep() { /* repeating work */ }
}
```

Semantics:

- **Duplicate names replace.** Scheduling a name that is already taken cancels
  the previous task and installs yours. `ctx.sched().names()` lists the
  currently scheduled names.
- **`cancel(name)` is idempotent.** It returns `true` when a scheduled task
  was cancelled and `false` for an unknown or already-cancelled name; it never
  throws. A currently running run is not interrupted — only its future runs
  are dropped.
- **A throwing task never kills the host.** The exception is logged (host log
  line `task <name> failed: …`) and swallowed: a periodic task keeps its
  schedule after a throwing run, a one-shot that throws is simply done.
- **Shutdown drops everything.** During host shutdown the scheduler stops
  accepting work after your `onShutdown` hooks and `stop()` have run, cancels
  every task and joins the executor with a bounded wait of 5 seconds before
  forcing the interrupt. Nothing you scheduled survives a restart; keep
  durable state in the database, not in the schedule.

## 4. Plugin-to-plugin API recipe

A plugin-to-plugin contract has two halves: an **exported API package** in the
manifest (so the consumer's class loader can see the types) and a **published
service** at runtime (so the consumer can find the instance). Both are needed:
visibility without a service leaves nothing to call; a service whose type the
consumer cannot load cannot be found (`find` matches the exact `Class` object).

Provider API — a tiny interface in its own package:

```java
package com.example.greeting.api;

public interface GreetingApi {
    String greet(String name);
}
```

Provider plugin — exports the API package and publishes the instance:

```java
package com.example.greeting;

import com.example.greeting.api.GreetingApi;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public final class GreetingPlugin implements JhinPlugin {

    @Override
    public void start(PluginContext ctx) {
        GreetingApi api = name -> "hello, " + name;
        ctx.services().publish(GreetingApi.class, api);
    }
}
```

Its manifest carries the visibility and dependency edges:

```json
{
  "id": "jhin.example.greeting",
  "version": "0.1.0",
  "apiVersion": 1,
  "name": "Greeting",
  "description": "Greets people through a published service.",
  "mainClass": "com.example.greeting.GreetingPlugin",
  "exports": ["com.example.greeting.api"],
  "requires": []
}
```

Consumer plugin — declares the dependency and looks the service up (lookups are
live: a provider loaded later appears in later `find`/`findAll` calls):

```java
package com.example.consumer;

import com.example.greeting.api.GreetingApi;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import java.util.Optional;

public final class ConsumerPlugin implements JhinPlugin {

    @Override
    public void start(PluginContext ctx) {
        Optional<GreetingApi> greeting = ctx.services().find(GreetingApi.class);
        ctx.log().info("greeting service present: {}", greeting.isPresent());
    }
}
```

Consumer manifest:

```json
{
  "id": "jhin.example.consumer",
  "version": "0.1.0",
  "apiVersion": 1,
  "name": "Consumer",
  "description": "Uses the greeting service.",
  "mainClass": "com.example.consumer.ConsumerPlugin",
  "exports": [],
  "requires": [{"id": "jhin.example.greeting", "versionRange": ">=0.1.0", "optional": false}]
}
```

Rules that bite in practice:

- `exports` are **package** names and cover sub-packages, never parents or
  siblings (section 6).
- `find*` resolves by the exact `Class` object: the API type must come from an
  exported package of a common ancestor loader (the shared SDK prefixes or the
  exporting plugin). Never bundle your own copy of the API class — you would
  hand out two incompatible `GreetingApi` classes.
- `publish` of a duplicate `(type, qualifier)` pair throws `PluginException`;
  use `publish(type, qualifier, instance)` when several implementations of one
  type must coexist and `find(type, qualifier)` / `findAll(type)` to consume
  them.
- `optional: true` in `requires` drops the edge when the dependency is absent:
  the plugin still loads and must probe before touching the other plugin's API
  classes (the `Class.forName` probe pattern in
  `plugins/example/src/main/java/com/astroreen/jhin/plugin/example/ExamplePlugin.java`).

### 4.1 The `jhin.sessions` service APIs

`jhin.sessions` publishes its lifecycle and metadata contracts as services in
the exported package `com.astroreen.jhin.plugin.sessions.api`. Depend on the
plugin and look each contract up with `ctx.services().find(…)`; lookups are
live, so a provider installed later appears in later calls.

**`SessionLifecycleService`** — the mutating lifecycle operations. Every
successful call updates the row, bumps `updatedAt` and emits one
`session_updated` event:

| Call | Effect |
|------|--------|
| `settle(id, SettleReason)` / `unsettle(id)` | close the thread and reopen it |
| `pin(id, order)` / `unpin(id)` | pin to the top of the sidebar / release |
| `snooze(id, untilTs)` / `snoozeFor(id, durationMs)` / `wake(id)` | hide the thread until a timestamp, or bring it back |
| `archive(id)` / `restore(id)` | put the thread away and bring it back |
| `setAutoSettle(id, enabled)` | per-session opt-out of the inactivity sweep |
| `regenerateTitle(id)` | re-ask the title SPI (not undoable) |

`SettleReason` is the wire enum of settle causes — `manual`, `inactive`,
`closed`, `pr_merged`, `other` — with `wire()` / `fromWire(String)` mapping to
the JSON names.

**Clear-aware patch** — `SessionStore.patch(id, patch, Set<ClearableField>)`
(and the `accountId` overload) writes the listed nullable columns back to
`NULL` alongside the non-null fields of the patch; the plain
`patch(id, patch)` never clears anything. `ClearableField` enumerates the
nullable columns a clear-aware patch may reset.

**`TitleService`** — the SPI that proposes a session title from its event
history: `String regenerate(Session session, List<EventRecord> history)`. The
sessions plugin defines the type and calls it; the run owner (`jhin.agent`'s
`TitleServiceImpl`) implements and publishes it. Contract: the result is never
`null` or blank — an implementation with nothing better falls back to the
current title instead of failing. Look it up at call time
(`services().find(TitleService.class)`), never cache it across the registry
lifetime.

**`UndoJournal`** — the short undo window over lifecycle operations (5 s by
default): `record(sessionId, OpKind, previousSnapshot)` (the lifecycle service
calls it before each write), `undo(sessionId)` and `undoLatest()` restore the
snapshot through the clear-aware patch and emit `session_updated`. `OpKind`
has one constant per undoable operation (settle, unpin, snooze, archive, …);
title regeneration is deliberately absent. Consecutive same-kind operations on
one session inside the window coalesce to the oldest snapshot; an expired
entry answers empty and mutates nothing. The journal is in-memory and
per-process: a second host instance gets its own empty journal (single-instance
assumption).

**`RunActivityService`** — the optional run-owner seam of the auto-settle
sweep: `boolean hasPendingApproval(String sessionId)`. The inactivity sweep
must not settle a session waiting on a tool-call approval; live runs are
detected from the run table, pending gates are asked of this service. With no
publisher the sweep settles on inactivity alone; a throwing implementation is
treated as blocked and the session is retried next sweep.

**`EventType.session_updated`** — the stream event (wire name
`session_updated`) every successful lifecycle operation emits; the payload is
the updated session as JSON. SSE consumers de-duplicate by sequence number as
usual (see [architecture.md](architecture.md) section 5.4).

## 5. Agent SPI chain semantics

The agent plugin (`jhin.agent`) exports `com.astroreen.jhin.plugin.agent.api`.
Contribute tools by publishing a `ToolProvider`; the agent resolves providers
live through `services().findAll(ToolProvider.class)` at run start, so a plugin
installed later contributes tools without a restart. Three chains run around
every call, and one chain shapes the system prompt. Compile against the agent
with `compileOnly 'com.astroreen:jhin-plugin-agent:0.2.0'` and guard the
registration with an API probe (section 4).

**Tool names — first wins.** Definitions are keyed by `ToolDefinition.name()`;
a name defined twice logs `WARN tool name '…' defined by both … and …; keeping
the first` and keeps the first definition in load order:

```java
package com.example.jhin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import java.util.List;

public final class ToolProviderExample implements ToolProvider {

    @Override
    public List<ToolDefinition> tools() {
        return List.of(new EchoTool());
    }

    private static final class EchoTool implements ToolDefinition {

        @Override
        public String name() {
            return "example_echo";
        }

        @Override
        public String label() {
            return "Echo";
        }

        @Override
        public String description() {
            return "Echoes the given text back.";
        }

        @Override
        public String parametersSchema() {
            return "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}";
        }

        @Override
        public String promptSnippet() {
            return "example_echo(text): echoes the text back.";
        }

        @Override
        public String promptGuidelines() {
            return "Use example_echo to verify that plugin tools are wired.";
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            return ToolResult.ok("echo: " + call.arguments());
        }
    }
}
```

**Guards — first block wins, and a throwing guard blocks.** Guards run in
plugin load order before `ToolDefinition.execute`; the first non-allowing
decision — or the first guard that throws — blocks the call and the remaining
guards are not consulted. A blocked call never executes and becomes an error
`tool_result` whose text starts with `Blocked: `:

```java
package com.example.jhin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolCallDecision;
import com.astroreen.jhin.plugin.agent.api.ToolCallGuard;

public final class GuardExample implements ToolCallGuard {

    @Override
    public ToolCallDecision check(ToolCall call) {
        if (call.name().startsWith("example_")) {
            return ToolCallDecision.block("example tools are disabled here");
        }
        return ToolCallDecision.allow();
    }
}
```

**Transformers — a throwing transformer is skipped.** Transformers run in load
order over the finished result; one that throws is logged and skipped, and one
that returns `null` is ignored — either way the chain continues with the last
good result. Use them for presentation (redaction, truncation), never for
control flow:

```java
package com.example.jhin;

import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.agent.api.ToolResultTransformer;

public final class TransformerExample implements ToolResultTransformer {

    @Override
    public ToolResult transform(ToolResult r) {
        if (r.error()) {
            return r;
        }
        String redacted = r.content().replaceAll("\\d{4,}", "####");
        return ToolResult.ok(redacted, r.structured());
    }
}
```

**Prompt interceptors — `null` or `PluginVetoException` aborts the run.**
Interceptors run in load order after the system prompt is composed; returning
the context (same or modified) continues, returning `null` or throwing
`PluginVetoException` ends the run with a single `error` event before the model
is ever called:

```java
package com.example.jhin;

import com.astroreen.jhin.plugin.agent.api.PluginVetoException;
import com.astroreen.jhin.plugin.agent.api.PromptContext;
import com.astroreen.jhin.plugin.agent.api.PromptInterceptor;

public final class InterceptorExample implements PromptInterceptor {

    @Override
    public PromptContext intercept(PromptContext ctx) throws PluginVetoException {
        if (ctx.systemPrompt().isBlank()) {
            throw new PluginVetoException("empty system prompt");
        }
        return ctx.withSystemPrompt(ctx.systemPrompt() + "\nBe brief.");
    }
}
```

## 6. Troubleshooting

**`ClassNotFoundException`.** The loader failure text is fixed-shape:

```text
plugin <id> cannot see <class>; visible exports: <sorted package list>
```

with `(none)` when no dependency exports anything. Read it as: the class name
was found nowhere the plugin may look — not under a shared prefix, not in any
exported dependency package, not in the plugin's own jar. Three usual causes:

1. **non-exported package** — the class lives in a dependency jar, but its
   package is not covered by that dependency's exports. Fix on the provider
   side: export the package (or a parent package — exports cover sub-packages,
   so exporting `com.example.api` also covers `com.example.api.internal`, but
   not `com.example` and not `com.example.other`).
2. **shared-prefix miss** — you reached for a kernel-internal class, another
   plugin's implementation class, or a library class that is not bundled in
   your jar. Only `com.astroreen.jhin.sdk.*`, `java.*`, `javax.*`, `jakarta.*`,
   `org.slf4j.*` and `com.fasterxml.jackson.*` are shared with the kernel.
   Bundle the library in your jar (the fat-jar task does this for runtime
   dependencies) or use the exported API package.
3. **own-jar shadowing** — your own jar is consulted last and the packaging
   deliberately excludes kernel-provided artifacts (`jhin-sdk*`, `slf4j-*`,
   `jackson-*`) and never packages `compileOnly` dependencies. A type you
   expected your own jar to supply can therefore be missing entirely; a type
   you did bundle under a package some dependency exports is answered by the
   dependency's copy first.

**Duplicate export ambiguity.** When two dependencies export the same package,
the loader logs
`WARN package <pkg> is exported by multiple dependencies: <id>, <id>; first match in topological order wins`
and keeps the first match. Disambiguate by removing one export or not depending
on both plugins.

**Route conflict.** `route conflict: <method> <path> already owned by <owner>`
means another plugin (or a previous registration of yours) already serves that
pair. Pick another path; the kernel's health/bootstrap fallbacks never cause
this — they are replaced silently.

**Migration refused.** `migration target <name> must start with prefix <prefix>`
means a `CREATE TABLE`/`CREATE INDEX` target is unprefixed. Build every name
from `db().tablePrefix()`.

**Plugin failed to load.** `GET /_jhin/health` reports `failed: [{id, reason}]`
and the boot report logs one line per failure; a failed plugin is isolated and
its dependents are cascade-skipped, never fatal to the host.

## 7. Packaging

**Manifest fields** (`jhin-plugin.json` at the jar root, one file per jar),
validated by `PluginManifest.validate` before any plugin class runs — all
problems are collected, not just the first:

| Field | Rule |
|-------|------|
| `id` | matches `^[a-z0-9][a-z0-9.\-]{2,63}$`, unique per host |
| `version` | matches `^\d+\.\d+\.\d+$` |
| `apiVersion` | must equal `ApiVersion.CURRENT` (currently `1`) |
| `name`, `description` | free-form human-readable identity |
| `mainClass` | qualified Java class name implementing `JhinPlugin` |
| `exports` | list of qualified Java package names (nullable = none) |
| `requires` | list of `{id, versionRange, optional}`; `versionRange` must match the `VersionRange` grammar (for example `>=0.2.0` or `0.2.x`) |

**Jar layout.** The shared build conventions
(`gradle/plugin-conventions.gradle`) assemble a fat jar: every runtime
dependency of the plugin is inlined, except the parts the kernel already
provides — artifacts named `jhin-sdk*`, `slf4j-*` and `jackson-*` are kept out,
and signature/INDEX files (`META-INF/*.SF`, `*.DSA`, `*.RSA`, `INDEX.LIST`) are
excluded. `compileOnly` dependencies are never packaged: they are compile-time
contracts resolved at runtime through the other plugin's exports. The archive
is `plugins/<name>/build/libs/jhin-plugin-<name>-<version>.jar` and must end up
as one file in `$JHIN_HOME/plugins/`.

**Manifest validation.** The standalone Gradle task checks the file is a valid
JSON object (it is deliberately not wired into the jar/build graph — a module
compiles without a manifest, packaging and QA invoke it):

```bash
./gradlew :jhin-plugin-<yours>:validateManifest
```

Full field validation with the load-time rules runs in the kernel at startup
(`PluginManifest.validate`), so a bad manifest never loads silently.

## 8. UI plugins: tokens, themes and decorative screens

**Screens are HTML.** A UI plugin builds screens as `Ui` trees with the
`jhin.ui-kit` builder and registers them through `jhin.ui`; it never hardcodes
a colour, a radius or a spacing value. The server renders each authored tree
to an HTML fragment (`HtmlRenderer.renderFragment`) and the wire carries it as
`{id, html}` — in the bootstrap `screens` array and in every
`GET /ui/screen/{id}` response. The `data-jhin-*` attribute protocol inside
that HTML is the wire contract the agent and the runtime address nodes by:
see [sdui.md](sdui.md) section 9 and [web-client.md](web-client.md), not this
page. The three building blocks of authoring are `UiTokens`, `PaletteGen` and
`ThemeCatalog`, all in the exported package
`com.astroreen.jhin.plugin.uikit`.

**Tokens.** `UiTokens` is the vocabulary of every visual constant. Reference a
token by family and key — `UiTokens.color("sidebar-row-hover")`,
`UiTokens.radius("lg")`, `UiTokens.space("control")`, `UiTokens.motion("fast")`
— and the helper returns the `$family.key` string the client resolves at
render time; an unknown key throws at build time, so a typo never reaches the
wire. The families are `color`, `contrast`, `radius`, `text`, `font`, `space`,
`layout`, `glass`, `motion`, `shadow`, `scroll` and `z` (the full key set is
`docs/sdui.md` section 2.2 and the bootstrap `tokens` block).

**Palette generator.** `PaletteGen.generate(appearance, canvasHex, accentHex)`
derives the complete semantic colour surface from two seeds — the perceptual
lightness ladder, WCAG-solved foregrounds, the +50° companion action colour
and the status blends — as a map keyed by the `UiTokens.COLOR_KEYS` names. Use
it to preview a theme or to derive a custom canvas/accent pair; an unparsable
seed throws `PaletteGen.PaletteError`.

**Theme catalogue.** `ThemeCatalog.ids()` lists the six selectable themes;
`ThemeCatalog.get(id)` returns one entry with its light and dark seed pairs
(`theme.seeds(appearance)`) and its `--stage-art-*` backdrop metadata
(`theme.stageArt(appearance)`). `ThemeCatalog.isReserved(id)` reports the
appearance modes (`system`, `light`, `dark`) that are never theme ids. The
selected id is persisted by `jhin.ui` as `themeId` (default `t3-chat`).

**Authoring a decorative screen.** A decorative control is a node whose
`action` is an inline directive list resolved entirely client-side — no server
round-trip, no database write:

```java
Ui.button("Split view")
    .demo(true)
    .action(Map.of("client", List.of(
        Map.of("op", "setState", "id", "diffView", "value", "split"),
        Map.of("op", "patch", "id", "diffBody", "html", "<div>two-column preview</div>"),
        Map.of("op", "toast", "text", "Preview only — no diff engine in this build"))))
    .build();
```

Every interactive node without a real effect MUST carry `demo(true)`
(`docs/sdui.md` section 2.1): the client paints the shared disabled-affordance
marker (a corner `preview` badge plus the tooltip `Preview only — not
available in this build`) so nothing decorative looks silently real. The
builder enforces it where the primitive is inherently decorative (for example
`diff_view`, whose `build()` throws `demo marker required` without it), and
the `DemoMarkerSweepTest` sweeps every decorative route. Real screens must
never carry `demo` on a real action. Decorative surfaces may read fixtures and
dispatch inline directives only — never a database write (plan section 14.1).
