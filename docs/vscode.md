# VSCode / JDT.LS troubleshooting

Jhin is a composite Gradle build (`includeBuild` for `sdk`, `kernel` and every
plugin) with fat-jar plugins. This interacts badly with the two importers the
VSCode Java extension can use, so this file records what broke, why, and the
recovery recipe. Read it before touching Java-related VSCode settings in this
repository.

## The two importers

The `vscjava.vscode-gradle` extension ships a Gradle Build Server (BSP) that
`redhat.java` uses to import the workspace. The switch is
`java.gradle.buildServer.enabled` (key belongs to `vscjava.vscode-gradle`,
not `redhat.java`; there is no `import.` in the name):

- `"on"` (default) — `GradleBuildServerProjectImporter` (BSP).
- `"off"` — classic `GradleProjectImporter` (Buildship).

Both importers appear in the JDT.LS log `Importers:` line regardless of mode;
that line does not tell you which one ran.

**Jhin requires BSP.** In classic Buildship mode the Gradle classpath
container resolves empty for every dependency that is satisfied by composite
build substitution (`jhin-sdk` via `includeBuild`, plugin `project(...)`
dependencies) while plain external Maven dependencies still resolve. Result:
`The import com.astroreen.jhin.sdk cannot be resolved` in every plugin.
Evidence: `.vscode/settings.json` pins `"java.gradle.buildServer.enabled":
"on"`; when it is absent or stale, errors return.

## Why a language-server restart is not enough

The BSP importer talks to the extension over a named pipe that is negotiated
once per VSCode process. Restarting only the language server (or killing
`org.eclipse.equinox.launcher`) makes the pipe handshake fail
(`Failed to connect to extension, Max attempts: 30`) and JDT.LS silently
falls back to classic Buildship — broken. Reusing an existing JDT workspace
also skips BSP (`applies()` returns false once Java projects already exist).

So **both** are required: a wiped JDT workspace **and** a full VSCode quit.

## Recovery recipe (only proven path)

1. `touch ~/.config/Code/User/workspaceStorage/*/redhat.java/jdt_ws/.cleanWorkspace`
   (the extension consumes this flag at activation and deletes the JDT
   workspace).
2. Quit VSCode completely (all windows) and reopen it.
3. Verify (see below).

Expected: log line `Updating classpaths for N projects (M build targets)
using batched BSP calls.` and zero unresolved imports.

## Verification

Force a reconcile of a file, then read the JDT workspace log:

```sh
code --goto plugins/example/src/main/java/com/astroreen/jhin/plugin/example/ExamplePlugin.java:14
grep "problems reported for" \
  ~/.config/Code/User/workspaceStorage/*/redhat.java/jdt_ws/.metadata/.log | tail
```

`0 problems reported for /ExamplePlugin.java` means BSP mode with a resolved
classpath. The `batched BSP calls` line in the same log is the mode marker.

## Known problems and their fixes

### `dev.langchain4j` unresolved in agent / qa-mock-llm / ui-default tests

Those plugins take langchain4j only transitively, through a `compileOnly
project(':jhin-plugin-llm')` dependency whose artifact is the fat jar (the
jar task inlines `runtimeClasspath`). Gradle resolves the classes; the build
server does not materialise them as external entries. Fix (commit `7caf7c4`):
declare `compileOnly platform('dev.langchain4j:langchain4j-bom:1.20.1')` and
`compileOnly 'dev.langchain4j:langchain4j-core'` (plus the `testCompileOnly`
mirror) directly in those plugins. `implementation` must not be used — it
would inline langchain4j into the fat jars, which the plugin design forbids.

### Nested builds poisoning the import

The scaffold template under `.opencode/` is a standalone Gradle build; when
Gradle auto-detection picks it up it can abort the whole workspace
initialisation. `.vscode/settings.json` keeps `**/.opencode/**` in
`java.import.exclusions` for this reason — do not remove it. The template
also logs a harmless `Could not read script
'.opencode/skill/gradle/plugin-conventions.gradle'` in the *Gradle for Java*
output when it is still evaluated in place; it is noise, not a Jhin build
failure.

`java.import.exclusions` alone does not stop this. That key belongs to
`redhat.java`, while nested-build discovery belongs to `vscjava.vscode-gradle`
and is governed by `gradle.nestedProjects` — see the next section.

### Import stalls on a `jhin-plugin-*` POM download

Symptom: the *Java Build Status* item sits on a single line and never
advances, with no error anywhere, for example

```
null Build Server Task - Download https://repo.maven.apache.org/maven2/com/astroreen/jhin-plugin-qa-mock-llm/0.2.0/jhin-plugin-qa-mock-llm-0.2.0.pom not found [Done]
```

Cause: `gradle.nestedProjects` was `true` (the extension default is `false`,
but a *user*-level `settings.json` can override it). With it on, the Gradle
extension discovers every nested `settings.gradle` and configures it as its
own root build — and every directory under `plugins/` is a valid standalone
build. A plugin configured outside the root composite gets no dependency
substitution, so `mavenLocal()` / `mavenCentral()` from
`gradle/plugin-conventions.gradle` take over and an internal coordinate such
as `com.astroreen:jhin-plugin-qa-mock-llm:0.2.0` (declared in
`plugins/agent/build.gradle`) escapes to Maven Central, 404s and leaves the
import stuck. The same discovery pass pulls in the `.opencode/` template,
which is where the stray Gradle 9.2.0 and JDK 17 daemons come from.

Fix: `"gradle.nestedProjects": false`, which overrides the user-level value
for this workspace only. It lives in the `generate-vscode-settings` template
in `devenv.nix`, not in the generated `.vscode/settings.json` — patching the
generated file is undone by the next shell entry. Re-enter the devenv shell
to regenerate, then restart VSCode fully; a language-server restart is not
enough. If the scaffold template was already configured in place, delete its
leftover `.opencode/skill/jhin-plugin/template/.gradle` cache.

### Language server becomes a zombie

Symptoms: syntax colouring still works (that is client-side TextMate
grammar), but semantic colours are gone and `F12` / Go to Definition does
nothing. Check the JDT log for `Forcing exit after 1 min.` — the server
received `shutdown` without a follow-up `exit` and hung after its forced
exit. The extension does not always respawn it. Recovery: the recipe above
(wipe + full restart); killing only the `java` process is not enough.

### `Null type safety: ... needs unchecked conversion` warnings

These come from Eclipse null analysis (`java.compile.nullAnalysis.mode`),
which is enabled globally in this machine's `java.nix`. The repository has
no nullability annotations, so the warnings are cosmetic. They were
previously suppressed per-workspace with
`"java.compile.nullAnalysis.mode": "disabled"` in `.vscode/settings.json`;
that key was removed again — warnings over a broken project was the chosen
trade-off, and enabling it again only changes warnings, never resolution.

## Settings that must stay in `.vscode/settings.json`

- `java.gradle.buildServer.enabled: "on"` — BSP, required (see above).
- `java.import.exclusions` — keep `**/.gradle*/**`, `**/.opencode/**`,
  `**/build/**`.
- `gradle.nestedProjects: false` — required even though it is the extension
  default, because a user-level `settings.json` may set it to `true`; see
  "Import stalls on a `jhin-plugin-*` POM download".
- `java.jdt.ls.java.home` / `java.import.gradle.java.home` — pinned to the
  nix openjdk 21 store path; update them together when the nix store path
  changes.
- `java.import.maven.enabled: false` — the build is Gradle-only; maven
  import only adds phantom projects.

Note: `.vscode/` is gitignored on purpose (machine-specific store paths).
This document is the shared part.

`.vscode/settings.json` is **generated**, not hand-maintained: the
`generate-vscode-settings` script in `devenv.nix` rewrites it on every shell
entry (it runs from `enterShell`). A manual edit survives only until the next
`direnv`/`devenv` shell, which is how settings from this list have silently
disappeared before. Change the template in `devenv.nix` and re-enter the
shell; never patch the generated file as the fix.
