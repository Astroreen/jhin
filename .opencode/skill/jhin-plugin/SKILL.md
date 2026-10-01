---
name: jhin-plugin
description: Scaffold and implement a Jhin plugin from a plain-language idea
---

# Jhin plugin scaffolding

Turn a plain-language idea into a buildable, installable Jhin plugin. A plugin
is one jar with a `jhin-plugin.json` manifest and one entry class implementing
`JhinPlugin`; the kernel loads it and runs everything it registers. Follow the
sections below in order: intake, decision table, naming table, file checklist,
render recipe, templates, install-and-verify, hard rules. The copy-paste
skeleton lives in `template/` next to this file.

Background: `docs/plugin-dev.md` (full `PluginContext` reference, one worked
example per surface), `plugins/example/` (the annotated reference plugin),
`docs/architecture.md` (class-loader and lifecycle rules).

## 1. Intake — 6 questions

Ask the user only what the idea itself does not answer. Never invent product
behavior; if an answer is unclear, ask again instead of guessing.

1. **What should it do?** One plain sentence. From it derive the plugin id
   (`jhin.<suffix>`, lowercase, dotted), the display name and the one-line
   description that go into the manifest.
2. **Which extension surfaces does it need?** Pick every row that applies from
   the decision table: HTTP route, HTTP filter (+ TLS), database migration +
   tables, stream events, CLI command, services for other plugins.
3. **Does it need other plugins' APIs?** Which `requires` (id + version range +
   optional flag) and which exported packages it imports. Does it expose an API
   of its own (then add an `exports` package)?
4. **Does it store data?** If yes, which tables/indices — every name must be
   built from `ctx.db().tablePrefix()`.
5. **Does it contribute tools or prompts to the agent?** If yes, it publishes an
   SPI from `jhin.agent` (`ToolProvider`, `PromptInterceptor`, `ToolCallGuard`,
   `ToolResultTransformer`) through `services()` and requires `jhin.agent`.
6. **Any UI contribution?** Screen JSON built with `jhin.ui-kit` nodes, a
   bootstrap override (`GET /_jhin/bootstrap`), or none.

## 2. Decision table — plain-language intent → surfaces

| Intent | Surfaces to build | Contract |
|--------|-------------------|----------|
| "show a screen to the user" | UI nodes from `jhin.ui-kit` + a route returning the screen JSON; override `GET /_jhin/bootstrap` to make it the home screen | `jhin.ui-kit` exports `com.astroreen.jhin.plugin.uikit` (`Ui`, `UiNode`) |
| "expose an endpoint / call an external service" | route | `ctx.http().route(new RouteSpec(...))` |
| "add an operator command" | CLI | `ctx.cli().command(new CliCommandSpec(...))` |
| "guard, authenticate or rewrite requests" | filter; `TlsProvider` only when the plugin owns the listener's key material | `ctx.http().filter(...)`, `ctx.http().tls(...)` |
| "keep state" | migration + read/write work units | `ctx.db().migrate(...)`, `ctx.db().read/write(...)` |
| "publish live updates" | stream topic + SSE route | `ctx.streams().publish(...)`, `ctx.streams().sse(...)` |
| "expose an API to other plugins" | `exports` package + service publication | `ctx.services().publish(Api.class, impl)` |
| "contribute tools to the agent" | `ToolProvider` published as a service, behind a `jhin.agent` probe | `requires jhin.agent` (optional) + `compileOnly 'com.astroreen:jhin-plugin-agent:0.2.0'` |
| "shape prompts, veto or rewrite tool calls" | `PromptInterceptor` / `ToolCallGuard` / `ToolResultTransformer` from `jhin.agent.api` | same probe pattern as tools |
| "read settings or secrets" | config section + `dataDir()` | `ctx.config()`, `ctx.dataDir()` — never hardcode, never log secrets |

## 3. Naming table — everything derived from the id

Worked example uses `jhin.notes` (module `plugins/notes`).

| Thing | Rule | Example |
|-------|------|---------|
| plugin id | `jhin.<suffix>`, matches `^[a-z0-9][a-z0-9.\-]{2,63}$` | `jhin.notes` |
| module dir | `<suffix>` with dots turned into dashes | `plugins/notes` |
| Gradle build name | `jhin-plugin-<module>` | `jhin-plugin-notes` |
| jar | `jhin-plugin-<module>-0.2.0.jar` | `jhin-plugin-notes-0.2.0.jar` |
| `__PLUGIN_ID__` | the id | `jhin.notes` |
| `__PLUGIN_NAME__` | display name, CamelCase of `<suffix>` | `Notes` |
| `__PKG__` | `com.astroreen.jhin.plugin.<suffix without '-'>` | `com.astroreen.jhin.plugin.notes` |
| main class | `<__PLUGIN_NAME__>Plugin` | `NotesPlugin` |
| route prefix | `/<module>` (never bare `/`) | `/notes` |
| table prefix | `ctx.db().tablePrefix()` — the kernel derives it from the id | `jhin_notes_` |

## 4. File checklist — a plugin module must have

```
plugins/<module>/
├── settings.gradle                                  standalone build name
├── build.gradle                                     applies plugin-conventions
├── src/main/resources/jhin-plugin.json              the manifest
├── src/main/java/<pkg-path>/
│   ├── <Name>Plugin.java                            implements JhinPlugin
│   ├── package-info.java                            package javadoc
│   └── …                                            one file per surface
└── src/test/java/<pkg-path>/
    ├── <Name>PluginTest.java                        happy + failure tests
    ├── FakePluginContext.java                       recording test double
    └── FakeHttpRequest.java                         request test double
```

plus one line in the **root** `settings.gradle`:

```groovy
includeBuild('plugins/<module>') { name = 'jhin-plugin-<module>' }
```

`template/` holds every file above with placeholders; render it (section 5)
instead of writing from scratch.

## 5. Render recipe

Placeholders: `__PLUGIN_ID__` (id), `__PLUGIN_NAME__` (display name),
`__PKG__` (root package). The `__PKG__` template directory expands to the
dotted package path; files named `__PLUGIN_NAME__…` are renamed the same way
their classes are.

```bash
module=notes id=jhin.notes name=Notes pkg=com.astroreen.jhin.plugin.notes
cp -r .opencode/skill/jhin-plugin/template "plugins/$module"
for base in src/main/java src/test/java; do
  mkdir -p "plugins/$module/$base/${pkg//.//}"
  mv "plugins/$module/$base/__PKG__/"* "plugins/$module/$base/${pkg//.//}/"
  rmdir "plugins/$module/$base/__PKG__"
done
find "plugins/$module" -depth -name '*__PLUGIN_NAME__*' | while read -r f; do
  mv "$f" "${f//__PLUGIN_NAME__/$name}"
done
grep -rl -e '__PLUGIN_ID__' -e '__PLUGIN_NAME__' -e '__PKG__' "plugins/$module" \
  | xargs sed -i "s/__PLUGIN_ID__/$id/g; s/__PLUGIN_NAME__/$name/g; s/__PKG__/$pkg/g"
```

Then wire the root `settings.gradle` (section 4) and extend the surfaces the
intake selected (section 2). Keep `version = '0.2.0'` and `apiVersion: 1`
unless the SDK contract itself changed.

## 6. Manifest — `src/main/resources/jhin-plugin.json`

```json
{
  "id": "jhin.notes",
  "version": "0.2.0",
  "apiVersion": 1,
  "name": "Notes",
  "description": "One sentence: what this plugin does.",
  "mainClass": "com.astroreen.jhin.plugin.notes.NotesPlugin",
  "exports": [],
  "requires": []
}
```

Field rules (enforced by `PluginManifest.validate` before any plugin class
runs): `id` matches `^[a-z0-9][a-z0-9.\-]{2,63}$`; `version` is `x.y.z`;
`apiVersion` equals `ApiVersion.CURRENT` (1); `mainClass` is a qualified Java
class name implementing `JhinPlugin`; every `exports` entry is a qualified Java
package name that exists in your jar (an entry like
`com.astroreen.jhin.plugin.notes-api` is refused — Java package segments cannot
contain dashes); every `requires` entry is
`{"id", "versionRange", "optional"}` with a valid version range (for example
`>=0.2.0`). `exports` and `requires` may be empty lists.

## 7. `build.gradle`

```groovy
// Jhin plugin module: <module> (jhin.<suffix>).
apply from: "${rootDir}/../../gradle/plugin-conventions.gradle"

group = 'com.astroreen'
version = '0.2.0'

dependencies {
    testRuntimeOnly 'org.junit.platform:junit-platform-launcher:1.11.4'
}
```

`plugin-conventions.gradle` supplies Java 21, the SDK (`compileOnly
'com.astroreen:jhin-sdk:0.2.0-SNAPSHOT'`), JUnit 5 + AssertJ and the fat-jar
packaging that keeps kernel-provided artifacts (`jhin-sdk*`, `slf4j-*`,
`jackson-*`) out of the archive. Depend on another plugin's API with
`compileOnly 'com.astroreen:jhin-plugin-<name>:0.2.0'` plus a `requires` entry —
never bundle the API into your jar. `settings.gradle` of the module is one
line: `rootProject.name = 'jhin-plugin-' + settingsDir.name`.

## 8. `JhinPlugin` skeleton

```java
package com.astroreen.jhin.plugin.notes;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public final class NotesPlugin implements JhinPlugin {

    @Override
    public void start(PluginContext ctx) throws Exception {
        // Register EVERYTHING here: routes, filters, migrations, streams,
        // CLI commands, services. Nothing may be registered after the HTTP
        // server is listening.
        Routes.install(ctx);
        ctx.log().info("jhin.notes started");
    }

    // Optional: release resources. The kernel calls it on shutdown, reverse
    // load order, best effort.
    @Override
    public void stop() {}
}
```

Use `ctx.onStarted(hook)` for work that needs a live server and
`ctx.onShutdown(hook)` for releasing resources; both are registered from
`start()`.

## 9. Test skeleton — FakePluginContext pattern, happy + failure

The tests drive the real plugin against a recording `PluginContext` double:
`FakePluginContext` captures routes/commands/migrations and throws
`UnsupportedOperationException` on the parts the test does not touch;
`FakeHttpRequest` is a fixed method+path request. Every plugin ships at least
one happy and one failure case before it is done.

```java
final class NotesPluginTest {

    @Test
    void startRegistersPingRouteAndPingAnswers200() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new NotesPlugin().start(ctx);

        RouteSpec route = ctx.routes().get(0);
        assertThat(route.method()).isEqualTo("GET");
        assertThat(route.path()).isEqualTo("/notes/ping");

        HttpResponse response = route.handler().handle(new FakeHttpRequest("GET", "/notes/ping"));
        assertThat(response.status()).isEqualTo(200);
        assertThat(new String(response.body(), StandardCharsets.UTF_8))
                .contains("\"plugin\":\"jhin.notes\"");
    }

    @Test
    void blankNameIsRefusedWith400NamingTheProblem() throws Exception {
        FakePluginContext ctx = new FakePluginContext();
        new NotesPlugin().start(ctx);

        HttpResponse response = ctx.routes().get(0).handler().handle(
                new FakeHttpRequest("GET", "/notes/ping", Map.of("name", List.of(""))));
        assertThat(response.status()).isEqualTo(400);
        assertThat(new String(response.body(), StandardCharsets.UTF_8))
                .contains("invalid_name");
    }
}
```

`template/src/test/java/__PKG__/` carries the working `FakePluginContext` and
`FakeHttpRequest` — copy them, do not rewrite them.

## 10. Install and verify

```bash
# 1. tests + jar must be green
./gradlew :jhin-plugin-<module>:test :jhin-plugin-<module>:jar

# 2. install (or use the jhin-plugin script of the dev shell)
cp plugins/<module>/build/libs/jhin-plugin-<module>-*.jar "${JHIN_HOME:-$HOME/.jhin}/plugins/"

# 3. restart the host (deploy/run.sh restart loop, or POST /admin/reload when
#    jhin.reload is loaded)

# 4. verify: the plugin is listed and the route answers
curl -s --max-time 5 "http://localhost:18443/_jhin/health"
curl -s --max-time 5 "http://localhost:18443/<module>/ping"
```

`/_jhin/health` lists loaded plugins under `plugins` and load failures under
`failed` with reasons. A plugin missing from both was dropped at manifest
validation — check the kernel log for `skipping …` lines.

## 11. Hard rules

1. **Never touch the kernel.** No changes under `kernel/` or `sdk/`; product
   behavior arrives as plugin jars, never as kernel patches.
2. **Never import a non-exported package.** Only your own packages plus the
   packages your dependencies declare in `exports` (and the shared SDK
   prefixes). A wrong import fails at load with
   `plugin <id> cannot see <class>; visible exports: …`.
3. **Always prefix tables and indices with the plugin prefix.** Build every
   name from `ctx.db().tablePrefix()`; the kernel refuses unprefixed
   `CREATE TABLE`/`CREATE INDEX` targets.
4. **Comments and docs in English.** Same rule as the rest of the repository.
5. **Happy AND failure tests before declaring done.** At least one happy and
   one failure case per behavior the plugin adds, green via
   `./gradlew :jhin-plugin-<module>:test`.
