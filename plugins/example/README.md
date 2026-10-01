# jhin.example — the reference plugin

A copy-paste template that demonstrates every extension surface of the Jhin
SDK in one small file (`ExamplePlugin.java`). Read it top to bottom: each
surface is labeled `SURFACE 1` … `SURFACE 5` with a comment explaining the
contract.

## The five surfaces

| # | Surface | What the example does | How to observe it |
|---|---------|-----------------------|-------------------|
| 1 | Route | `GET /example/status` answers a JSON observability payload (`plugin`, `tools`, `events`, `topic`) | `curl -s http://localhost:8443/example/status` |
| 2 | CLI command | `example-hello [name]` prints a greeting and returns exit code 0 | `java -jar <kernel.jar> cli example-hello world` |
| 3 | Migration + table | migration 1 creates `jhin_example_notes` (the plugin table prefix `jhin_example_` + `notes`, as the kernel's prefix guard requires) | `sqlite3 $JHIN_HOME/data/jhin.db "SELECT name FROM sqlite_master WHERE name='jhin_example_notes'"` |
| 4 | Stream publisher | publishes `example_ready` at startup and `example_status` on every status call to the topic `example/events`, each recorded as a note row; `GET /example/stream` serves the topic over SSE | `curl -sN http://localhost:8443/example/stream` while calling the status route |
| 5 | Optional ToolProvider | contributes the `example_echo` tool to `jhin.agent`, registered only when the agent API class resolves (the `jhin.ui` Integrations probe pattern) | `"tools":1` in the status payload with `jhin.agent` loaded, `"tools":0` without it |

The status route is the QA observation point: it reports how many tools the
plugin registered and how many stream events it published. Every publish also
inserts one `jhin_example_notes` row, so the event history is inspectable
after the fact.

## Build and install

```bash
./gradlew :jhin-plugin-example:jar && cp plugins/example/build/libs/*.jar ~/.jhin/plugins/
```

Then restart the hub (or `POST /admin/reload` when `jhin.reload` is loaded).
The kernel also seeds bundled jars from `JHIN_BUNDLED_PLUGINS`; copying the
jar into `~/.jhin/plugins/` yourself is the user-install path.

## Optional dependency on jhin.agent

The manifest declares one `optional` requirement on `jhin.agent`. Optional
requirements are dropped from the load graph when the target is absent, so the
plugin loads fine without the agent and registers zero tools; when the agent
is loaded, its exported SPI classes become visible and `ExampleToolProvider`
is registered. The tool classes are never touched unless the API probe
succeeds, so no linkage error can occur in the absent case.

## Using this as a template

1. Copy `plugins/example/` and rename the module, the package and the
   manifest (`id`, `mainClass`, `description`).
2. Replace the demo handlers with your own; keep the surface structure.
3. Keep every table and index name prefixed with `db().tablePrefix()` — the
   kernel rejects migrations that violate it.
