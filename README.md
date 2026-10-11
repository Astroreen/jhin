# Jhin

Jhin is a self-hosted coding agent. One host process loads plugin jars from a
local directory and executes everything itself — sessions, security, LLM
providers, the agent loop, tools and every screen are plugins — and the only
client is the HTML web client the host serves: a thin vanilla-JS runtime over
server-rendered HTML.

## How it fits together

```
+--------------------------------------------------------------+
|  HTML web client (any browser)                               |
|  thin vanilla-JS runtime over server-rendered HTML           |
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
3. **HTML web client** — a thin vanilla-JS runtime the host serves. It
   hardcodes exactly one surface (the pairing fallback — the enroll form shown
   on 401/403) and one endpoint (the bootstrap fetch); everything else is
   server-driven HTML.

## Install from a release bundle

Requirements: a Java 21 runtime — the host serves the web client itself;
there is no client to install and no client build.

1. Unpack the release bundle and start the host:

   ```bash
   ./run.sh
   ```

   `run.sh` runs the kernel jar in a restart loop (exit code 0 means
   "restart requested", e.g. after `POST /admin/reload`). The data directory is
   `JHIN_HOME` (default `~/.jhin`): `data/jhin.db`, `plugins/`, `keystore/`,
   `logs/`. Default listener: `https://0.0.0.0:8443`. With the security plugin
   loaded, a self-signed certificate is generated into `keystore/` on first
   start and its SHA-256 fingerprint is logged for verification.

2. Open `https://host:8443/` in a browser. The web client fetches
   `GET /_jhin/bootstrap` and renders whatever the server sent. With the
   security plugin installed and no device token yet, the server answers
   `401`/`403` and the client shows its built-in pairing form: enroll the
   browser with a single-use code issued by the host CLI
   (`cli create-enrollment <account>`) and the issued device token is stored
   for the origin.

3. TLS: with the security plugin the listener speaks HTTPS with a self-signed
   certificate; the browser decides what to accept — the web runtime pins no
   certificates. Verify the logged SHA-256 fingerprint out of band if your
   threat model asks for it.

## Empty by default

A bare kernel serves exactly two endpoints — `GET /_jhin/health` (kernel
identity and the plugin catalog) and `GET /_jhin/bootstrap` (`empty: true` —
the client shows its "no UI plugin installed" state) — and renders nothing
else. Everything you see in a full product arrives as plugin jars; install them
into `$JHIN_HOME/plugins/` and restart the host. Bundled jars of the
distribution are seeded there automatically on start (a user-modified copy is
never overwritten).

## Building the distribution

There is no client toolchain: the web client is plain HTML, CSS and JavaScript
files that ship inside the `jhin.ui` plugin jar and are served by the host.
Everything builds with the Gradle wrapper and a fat jar:

```bash
./gradlew build   # sdk, kernel and the plugin jars
./gradlew dist    # the release bundle: kernel jar + plugin jars + run.sh
```

## Updating and upgrades

Upgrades apply themselves; there is no manual migration step:

- **Host data.** Database migrations run automatically on every start, before
  any plugin loads; applied versions are recorded and skipped afterwards —
  restarting the host is the whole upgrade procedure.
- **Client data.** The web runtime's persisted store is a versioned envelope;
  its migrations run automatically at startup (see
  [docs/updates.md](docs/updates.md)).
- **Version gate.** A client below the wire floor is refused with
  `426 Upgrade Required`; one whose stored schema is below `minSchema` gets
  the built-in "update required" surface instead of product screens (the
  bootstrap `contract` block is what is compared).
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
  payload, the primitive catalog (68 primitives), action protocol, client
  directives, stream frames, expressions and caching.

Service deployment (restart loop, systemd unit, data directory):
[deploy/README.md](deploy/README.md). Architecture principles and the
must-not list: [AGENTS.md](AGENTS.md).
