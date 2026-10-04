# Jhin

Jhin is a self-hosted coding agent. One host process loads plugin jars from a
local directory and executes everything itself — sessions, security, LLM
providers, the agent loop, tools and every screen are plugins — and one Flutter
client renders the UI on Android, Linux desktop and Web.

## How it fits together

```
+--------------------------------------------------------------+
|  Flutter SDUI client (Android / Linux / Web)                 |
|  renders server-authored JSON over a catalog of 58           |
+-------------------------------+------------------------------+
                                | JSON + SSE
+-------------------------------v------------------------------+
|  Kernel: plugin loader, registries, HTTP host, SQLite        |
|  - owns only /_jhin/health and /_jhin/bootstrap              |
+-------------------------------+------------------------------+
                                | PluginContext (registries)
+-------------------------------v------------------------------+
|  Plugins: sessions, security, llm, agent, tools, mcp, ui     |
|  - the entire product lives here, one class loader each      |
+--------------------------------------------------------------+
```

Three layers, strictly separated:

1. **Kernel** — a generic plugin host with six concepts (plugin, manifest,
   exports/requires, class loader, service registry, lifecycle). It contains no
   product code and no domain vocabulary; a bare kernel is not a product.
2. **Plugins** — the product itself, delivered as jars into
   `$JHIN_HOME/plugins/`. Every behaviour a plugin may adjust arrives this way,
   never as a kernel patch.
3. **Flutter SDUI client** — a thin renderer. It hardcodes exactly one screen
   (server profiles) and one endpoint (the bootstrap fetch); everything else is
   server-driven UI.

## Install from a release bundle

Requirements: a Java 21 runtime for the host; the client ships as an app
bundle or a desktop/web build.

1. Unpack the release bundle and start the host:

   ```bash
   ./run.sh
   ```

   `run.sh` runs the kernel jar in a restart loop (exit code 0 means
   "restart requested", e.g. after `POST /admin/reload`). The data directory is
   `JHIN_HOME` (default `~/.jhin`): `data/jhin.db`, `plugins/`, `keystore/`,
   `logs/`. Default listener: `https://0.0.0.0:8443`. With the security plugin
   loaded, a self-signed certificate is generated into `keystore/` on first
   start and its SHA-256 fingerprint is logged for pinning.

2. Open the client and enter the server URL on the profile screen (for example
   `https://host:8443`). The client probes `GET /_jhin/health`, then fetches
   `GET /_jhin/bootstrap` and renders whatever the server sent. Enrollment
   (device tokens) is a server-driven flow once the security plugin is
   installed.

3. Trust-on-first-use: the first accepted TLS fingerprint is pinned per
   profile and mismatches are refused afterwards. On **web**, certificate
   acceptance is client-side — the browser decides about self-signed
   certificates; pinning applies to the native clients.

## Empty by default

A bare kernel serves exactly two endpoints — `GET /_jhin/health` (kernel
identity and the plugin catalog) and `GET /_jhin/bootstrap` (`empty: true` —
the client shows its "no UI plugin installed" state) — and renders nothing
else. Everything you see in a full product arrives as plugin jars; install them
into `$JHIN_HOME/plugins/` and restart the host. Bundled jars of the
distribution are seeded there automatically on start (a user-modified copy is
never overwritten).

## Building the clients

The Flutter client (Android / Linux desktop / Web) is built with the standard
Flutter toolchain. Release builds **must** pass `--no-tree-shake-icons`:

```bash
flutter build apk --release --no-tree-shake-icons
flutter build linux --release --no-tree-shake-icons
flutter build web --release --no-tree-shake-icons
```

The client resolves icon names through a generated registry
(`frontend/lib/design/icon_registry.dart`, regenerated with
`devenv shell -- dart frontend/tool/gen_icons.dart`) instead of compile-time
`Icons.*` references, so the icon tree-shaker cannot see which glyphs are
used and would strip them from the font. The flag keeps the full Material
icon font in the binary; the size cost is accepted. Debug builds are
unaffected (no icon tree shaking runs there).

## Updating and upgrades

Upgrades apply themselves; there is no manual migration step:

- **Host data.** Database migrations run automatically on every start, before
  any plugin loads; applied versions are recorded and skipped afterwards —
  restarting the host is the whole upgrade procedure.
- **Client data.** The client's persisted store is a versioned envelope; its
  migrations run automatically at client startup (see
  [docs/updates.md](docs/updates.md)).
- **Version gate.** When the client build and the server disagree about the
  wire contract or the data schema, the client shows a built-in "update
  required" surface instead of product screens (the bootstrap `contract` block
  is what is compared).
- **Downgrades never destroy data.** Values written by a newer schema are
  quarantined (`migration.quarantine`) rather than deleted, so returning to an
  older build loses nothing.

## Documentation

- [docs/architecture.md](docs/architecture.md) — runtime architecture: boot
  order, class loading and visibility, routes/filters/TLS, streams, database
  ownership, bundled seeding.
- [docs/plugin-dev.md](docs/plugin-dev.md) — writing plugins: quickstart,
  `PluginContext` reference, one example per extension surface, plugin-to-plugin
  APIs, agent SPI chains, troubleshooting, packaging.
- [docs/sdui.md](docs/sdui.md) — the server-driven UI contract: bootstrap
  payload, the primitive catalog (58 primitives), action protocol, client
  directives, stream frames, expressions and caching.

Service deployment (restart loop, systemd unit, data directory):
[deploy/README.md](deploy/README.md). Architecture principles and the
must-not list: [AGENTS.md](AGENTS.md).
