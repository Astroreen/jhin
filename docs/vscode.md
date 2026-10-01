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

### Android / nested builds poisoning the import

`frontend/android` and the scaffold template under `.opencode/` used to be
picked up by Gradle auto-detection. The Android Gradle plugin runs against a
read-only nix store path and fails, which used to abort the whole workspace
initialisation. `.vscode/settings.json` keeps `**/frontend/**` and
`**/.opencode/**` in `java.import.exclusions` for this reason — do not remove
them. The template also logs a harmless `Could not read script
'.opencode/skill/gradle/plugin-conventions.gradle'` in the *Gradle for Java*
output when it is still evaluated in place; it is noise, not a Jhin build
failure.

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
- `java.import.exclusions` — keep `**/frontend/**`, `**/.gradle*/**`,
  `**/.opencode/**`, `**/build/**`.
- `java.jdt.ls.java.home` / `java.import.gradle.java.home` — pinned to the
  nix openjdk 21 store path; update them together when the nix store path
  changes.
- `java.import.maven.enabled: false` — the build is Gradle-only; maven
  import only adds phantom projects.

Note: `.vscode/` is gitignored on purpose (machine-specific store paths).
This document is the shared part.
