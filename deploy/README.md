# Running Jhin as a service

Quickstart and product overview live in the top-level [README.md](../README.md).
This page covers service deployment: running the kernel jar, the restart loop
for `POST /admin/reload`, the systemd unit example and the data directory.

## Requirements

A Java 21 runtime. Nothing else: the kernel is one fat jar and every tool is
pure Java.

## 1. Plain jar run

```bash
java -jar kernel-0.2.0-SNAPSHOT.jar
```

Useful arguments: `--server.port=8443` (listening port) and the Spring-style
`--key=value` overrides for any kernel property. The data directory is
`JHIN_HOME` (default `~/.jhin`): `data/jhin.db`, `plugins/`, `keystore/`,
`logs/`. With the `jhin.security` plugin loaded the listener speaks HTTPS
with a self-signed certificate generated into `keystore/` on first start (the
SHA-256 fingerprint is logged for pinning).

## 2. Restart loop: deploy/run.sh

```bash
./deploy/run.sh /opt/jhin/kernel-0.2.0-SNAPSHOT.jar --server.port=8443
```

The script runs the jar in a loop and starts it again one second after any
exit. **Exit code 0 means "restart requested"**: `POST /admin/reload` (plugin
`jhin.reload`) answers `202 {"status":"restarting"}`, waits 300 ms so the
response reaches the client, then exits the JVM with code 0 — the loop brings
the host back up with a freshly loaded plugin set. Any other exit code is a
crash and is restarted the same way. The jar path defaults to the boot jar
under `kernel/build/libs/` when omitted; extra arguments are passed to the
kernel.

## 3. systemd

Example unit ([jhin.service](jhin.service)):

```ini
[Unit]
Description=Jhin hub
After=network.target

[Service]
Type=simple
# set the service account below (and give it JHIN_HOME)
Environment=JHIN_HOME=/var/lib/jhin
ExecStart=/usr/bin/java -jar /opt/jhin/kernel-0.2.0-SNAPSHOT.jar
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

Create `/var/lib/jhin` up front and hand it to the service account.
`Restart=always` is what services `/admin/reload`: after the clean exit the
unit starts the process again. systemd adds supervision (journal, limits,
crash recovery); `run.sh` only restarts. Both honour the reload contract.

## /admin/reload contract

`POST /admin/reload` (plugin `jhin.reload`, no requirements):

1. Responds `202` with body `{"status":"restarting"}` immediately.
2. After 300 ms exits the JVM with code 0 (the exit is armed only after the
   host finished starting, so a request racing the boot is deferred to
   startup completion).
3. The external restarter (run.sh loop or systemd) starts a new process.

Clients survive the restart: SSE streams reconnect and resume from their last
`seq`, so the gap is invisible in the UI.

## Installing plugins

Plugin jars live in `$JHIN_HOME/plugins/`. Either copy them there yourself:

```bash
cp jhin-plugin-example-0.2.0.jar ~/.jhin/plugins/
```

or ship them in the distribution bundle (`JHIN_BUNDLED_PLUGINS` or a
`plugins-default/` directory next to the kernel jar): the kernel seeds the
bundle into the home plugin directory on start and leaves user-installed
files alone. A restart (or `/admin/reload`) loads any new jar. The
`jhin.example` plugin README shows the full build-and-install flow.

## Backup

Back up two things from `$JHIN_HOME`:

1. `data/jhin.db` — with the process stopped, copy the file; while running,
   use `sqlite3 $JHIN_HOME/data/jhin.db ".backup '/backup/jhin.db'"` (the WAL
   companions `jhin.db-wal` / `jhin.db-shm` belong to the live process).
2. `keystore/` — separately and always: losing it regenerates the
   certificate on next start and pinned clients will refuse the new one.

## Upgrades

1. Stop the service.
2. Replace the jar.
3. Start the service.

Schema migrations are idempotent (applied versions are recorded in
`data/jhin.db`), so a restart on the same `JHIN_HOME` is always safe; data and
keystore stay in place.
