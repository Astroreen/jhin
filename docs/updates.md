# Jhin data-upgrade system

When the app version changes and new data or code lands, the client inspects
its old persisted data and *transforms it* so it keeps working — exactly how
normal app update systems behave. This document is **normative** for the
persisted-state half of that system (the wire/payload half — `api`
negotiation and cached-payload versioning — lives in
[sdui.md](sdui.md) sections 6 and 8). Two versioned surfaces, one runner
model.

## 1. Persisted-key envelope

Every non-secure persisted key of the web runtime's local store
(`localStorage`, the `jhin.*` keys of [sdui.md](sdui.md) section 8) gets an
**envelope**:

```json
{
  "schema": 5,
  "app": "0.2.0",
  "writtenAt": "2026-10-11T09:30:00Z",
  "data": {
    "mod+shift+p": "palette.open",
    "mod+enter": "composer.send"
  }
}
```

Envelope fields:

| Field | Type | Meaning |
|-------|------|---------|
| `schema` | int | persisted-data schema version the `data` blob was written at |
| `app` | semver | app version that wrote the blob |
| `writtenAt` | string | ISO-8601 UTC timestamp of the write |
| `data` | object | the actual payload |

**Precedent:** a stored value with no envelope is legacy `schema 1` — it is
wrapped and migrated on first read.

Current keys and their owners: `jhin.bootstrap` (the last successful bootstrap
payload, cached so the offline and error art can paint), `jhin.screens`
(screen id → HTML, an LRU bounded at 50), `jhin.keybindings` (user keymap
overrides) and the `storeKey`-named UI-state keys (for example the sidebar
section collapse state). **The bearer token is NOT enveloped** —
`jhin.token` (the `secure_storage` capability) is opaque and
version-independent.

## 2. StoreMigration API

Migration model (the web runtime's store module,
`plugins/ui-default/src/main/resources/web/app.js`):

```js
// one step of the chain
class StoreMigration {
  from; to;
  upgrade(data) {}   // in-place transform of the `data` blob
}
const StoreMigrations = {
  current: 5,
  steps: [v1ToV2, v2ToV3, v3ToV4, v4ToV5]
};
// MigrationRunner.run(storage) -> MigrationReport (see rules below)
```

`MigrationReport` carries what happened: the keys migrated, the keys
quarantined and the number of failures. The runtime awaits it before the
first render.

## 3. The six runner rules

All tested. Stated verbatim; every implementation and future step must
satisfy them exactly.

1. **Precedent:** on first read, a key without an envelope is legacy
   `schema 1` — wrapped and migrated.
2. **Ordered, atomic per key:** apply `from→to` steps in order; before
   mutating, copy the raw value to `migration.backup:<key>`; on success write
   the enveloped value and delete the backup; on throw, restore the backup
   and record the key in `migration.quarantine`.
3. **Forward data (downgrade):** if `envelope.schema > current`, do NOT touch
   the value. Copy it to `migration.quarantine:<key>:<schema>` and keep the
   app running on defaults; show the built-in `version_gate` "some data was
   saved by a newer version" banner until dismissed. Never destroy newer
   data.
4. **Partial failure is survivable:** one failing key quarantines itself;
   other keys still migrate; the app boots.
5. **Runs before anything reads state:** the runner completes before the
   runtime renders any state; failures surface in the built-in error chrome
   but never block the shell.
6. **Version gate:** a client that passes the upgrade gate (`api` ≥ 4) but
   whose stored `schema` is below `contract.minSchema` (`5`) gets the
   `version_gate` entry — the "update required" surface, a *client-owned*
   screen (allowed by C-10 — it is chrome, not product). A client declaring
   `api` < 4 never reaches the gate: it is refused with `426 Upgrade Required`
   ([sdui.md](sdui.md) section 6).

## 4. Downgrade and quarantine behavior

Two bookkeeping keys exist, both persisted:

- `migration.backup:<key>` — the raw pre-migration copy of one key. Written
  before the first step touches the key, deleted after the enveloped value is
  committed. A backup left behind means the last run failed for that key.
- `migration.quarantine` — the list of keys whose migration threw. Quarantined
  keys keep their last good value (restored from the backup) and the app runs
  on defaults for them.
- `migration.quarantine:<key>:<schema>` — a copy of a value written by a
  **newer** schema than the running app understands (rule 3). The original is
  left untouched and the app keeps running on defaults; the `version_gate`
  banner stays up until dismissed.

Downgrades never destroy data: newer data is quarantined, older data is
migrated forward, and nothing is ever deleted except the backup after a
successful commit.

## 5. Schema steps

`StoreMigrations.current` is `5` (`CLIENT_SCHEMA`). The steps defined so far
(1 → 4 are the numbering history of the retired client's store; 4 → 5 re-bases
the web runtime's local store):

| Step | What it does |
|------|--------------|
| 1 → 2 | wrap legacy blobs into the envelope and split `sessionState` per profile |
| 2 → 3 | introduce `appearance` + `keybindings` + `tokensEtag` and migrate the old `theme` key into `appearance` |
| 3 → 4 | persist the selected catalogue theme id: `appearance` gains `themeId` (default `t3-chat`), merged without clobbering (T85) |
| 4 → 5 | the contract-level-4 store: the persisted key set becomes the web runtime's `jhin.*` keys ([sdui.md](sdui.md) section 8); anything the step cannot interpret is quarantined (rule 3), never deleted |

## 6. How to add a migration step

1. Bump `StoreMigrations.current` to the new schema version `N + 1`.
2. Add a `StoreMigration` step (`from = N`, `to = N + 1`) in the web runtime's
   store module (`plugins/ui-default/src/main/resources/web/app.js`): an
   `upgrade()` that transforms the `data` blob **in place** (mutate the map;
   do not return a new one).
3. Append the step to `StoreMigrations.steps` — order matters, the runner
   applies `from→to` steps in list order.
4. Add tests with real blobs: a legacy (un-enveloped) fixture, a fixture at
   the previous schema, and a fixture from the future (schema > current) to
   prove the quarantine path; plus a full-chain rerun over all steps.
5. Update the schema-steps table above and, when the server must refuse older
   clients, bump `contract.schema`/`contract.minSchema` in the bootstrap
   payload (see [sdui.md](sdui.md) section 1).
6. Never edit an already-shipped step — a fix is a new step on top. Shipped
   blobs in the wild were migrated by the old code; rewriting history loses
   them.

## 7. Server-side data

Plugin DB migrations (`MigrationSpec`, strictly increasing versions,
prefixed tables) keep doing their job for server-side schema changes. Nothing
new is needed there; this document covers client-persisted state only. One
server-side note: the sessions undo journal (the 5-second undo window) is
in-memory and therefore assumes a single host instance — a second instance
cannot see the first one's entries.

## 8. Build note: the web runtime ships as-is

There is no client build and no client toolchain: `app.js` and `app.css` are
committed plain files inside the `jhin.ui` plugin jar and the host serves them
from `GET /ui/assets/*`. Nothing about the client has to be flagged or bundled
at release time — `./gradlew dist` assembles the whole distribution (see the
top-level [README](../README.md) build section). The persisted-state
migrations above run unchanged.

## 9. Release notes: the UI overhaul

What a user sees after this update.

**Sidebar and thread lifecycle.** The session sidebar is grouped into
t3code-style sections — pinned, active and settled threads — and every thread
carries its lifecycle actions: *pin* keeps it on top, *settle* marks a thread
done and moves it to its own section, *snooze* hides it until it is needed
again and *archive* retires it. Every lifecycle move has a 5-second *undo*
window; the last action can be taken back from the toast before it settles
for good.

**Keyboard-first navigation.** Shortcuts cover the daily loop (new thread,
search, command palette, lifecycle actions); the command palette runs every
command by name, and any shortcut can be rebound in the keyboard settings —
nothing is hardwired to one layout.

**Themes and appearance.** The appearance settings drive the whole client
from the server's theme: light, dark or system appearance, accent and canvas
colors, the `colors{}` token overrides, spacing density
(`compact | comfortable | spacious`) and motion durations. Reduced-motion is
honored — when the OS asks for it, every animation duration collapses to
zero. Nothing is styled from a hardcoded value; the client renders from the
token lattice alone.

**Upgrades.** The client and the host upgrade independently and safely. On
version change the client migrates its own persisted state through the
envelope and runner model above, and the host migrates its database through
plugin migrations. When the client and server disagree on the contract level,
a version gate screen states plainly what is too old or too new and what to
update — the app never renders a broken half-state.

## 10. Release notes: the t3code UI clone

This release aligns the client's visual language with the t3code design system
and grows the SDUI contract to **level 3** (schema `4`).

**What was copied.** The token vocabulary (the 56 semantic `--color-*` aliases
plus the `contrast`, `radius`, `text`, `font`, `space`, `layout`, `glass`,
`motion`, `shadow`, `scroll` and `z` families), the six-theme catalogue
(`t3-chat`, `grove`, `ocean`, `ember`, `iris` and the `jhin` identity theme),
the two-seed OKLCH palette generator with WCAG-solved foregrounds, and the
primitive catalog grown from 58 to **68** (the ten level-3 catalog additions:
`hover_card`, `toast_stack`, `split`, `kbd`, `scroll_fade`, `diff_view` and
the universal `glass`, `demo`, `statusPulse` and `safeArea`, plus the
`glassTint` companion of `glass`). The shell, sidebar, chat timeline, settings
panels, command palette and keyboard-first navigation were ported to the same
visual contracts.

**What is decorative.** Several surfaces have no backend in this build and are
presentation only: the terminal drawer, the diff viewer and changed-files
tree, the browser preview, the usage and pull-request pages, the device
pairing / connect / welcome / project screens and the decorative settings
panels (connections, integrations, projects, scheduled tasks, source control,
snap-shot). Every interactive node on those surfaces carries the universal
`demo: true` marker and dispatches inline client directives only — it never
writes to the database. The client paints the shared disabled-affordance
marker (a corner `preview` badge plus the tooltip `Preview only — not
available in this build`) so nothing decorative looks silently real.

**What to strip.** The clone is designed to be extended: drop the `demo` nodes
and replace their inline directives with real actions. The token layer, the
palette generator and the decorative mechanism are the intended seams — the
rest of the UI keeps working unchanged.

## 11. End-to-end verification of the upgrade path

The upgrade surfaces are proven at contract level 4 by the headless QA
scripts (curl + gradle) and the SDK tests:

- **Upgrade gate.** `scripts/qa/t202.sh` fetches `GET /_jhin/bootstrap` with
  a below-floor client and with no `X-Jhin-Client` header at all and asserts the
  `426 Upgrade Required` refusal with the exact `contract_upgrade` body
  (`minApi: 4`); `GET /_jhin/health` stays `200`.
- **Version gate.** `BootstrapContractTest` asserts the `version_gate` entry
  for a client whose declared schema is below `contract.minSchema` (HTTP 200,
  never a crash) and the product entry for a client at `schema=5`.
- **Release bundle.** `scripts/qa/e2e-bundle.sh` boots the assembled bundle in
  a throwaway `JHIN_HOME` and runs one real agent turn end to end.

## 12. Release notes: the release bundle

`./gradlew dist` assembles the installable bundle under `dist/` (the generated
`dist/README.md` and [deploy/README.md](../deploy/README.md) carry the install
steps). This section records what the bundle carries, what is decorative in it
and what to strip; the clone-level notes are in §10.

**What was copied into the bundle.** The kernel boot jar
(`jhin-kernel-<version>.jar`), the ten default plugin jars under
`plugins-default/` — sessions, security, llm, llm-builtin, agent,
tools-builtin, mcp, ui-kit, ui-default and reload — the restart loop `run.sh`
and a `MANIFEST.txt` with the size and SHA-256 of every artifact. The web
client is not a separate artifact: its plain HTML/CSS/JS files ship inside the
`jhin.ui` jar and the host serves them at `GET /`. The `jhin.example`
copy-paste template and the `jhin.qa-mock-llm` harness are built with the
rest but are deliberately never copied: the `dist` task fails if either name
appears anywhere inside `dist/`.

**What is decorative.** The bundle ships the same decorative surfaces the
clone documents in §10 — the terminal drawer, the diff viewer and changed-files
tree, the browser preview, the usage and pull-request pages, the device
pairing / connect / welcome / project screens and the decorative settings
panels. They are presentation only: every interactive node carries
`demo: true` and dispatches inline client directives, never a database write,
and the client paints the shared disabled-affordance marker so nothing
decorative looks silently real.

**What to strip.** The bundle is a set of independent plugin jars: delete a
jar from `plugins-default/` (or from `$JHIN_HOME/plugins/`) and restart to
remove that feature — the kernel boots with whatever remains and reports the
missing dependency in the log (`plugin load finished with N failed: …`). To
remove the decorative surfaces themselves, drop the `demo` nodes and replace
their inline directives with real actions; the token layer, the palette
generator and the decorative mechanism are the intended seams (§10).

## 13. Release notes: the HTML web client (contract level 4)

**What changed.** The wire is HTML now: every screen travels as an
`{id, html}` fragment rendered from the plugin's `Ui` tree, and the JSON
node-tree payloads are gone. The only client is the web client the host serves
at `GET /` — there is no separate client install and no client build to run at
upgrade time.

**Breaking: old clients are refused.** A request that declares
`X-Jhin-Client: api < 4`, or carries no such header at all, is answered with
`426 Upgrade Required` and the `contract_upgrade` body instead of any payload
([sdui.md](sdui.md) section 6). There is no downgrade path and no dual-wire
period: upgrade the client, not the server.

**Schema 5.** The persisted-data schema is `5` (`CLIENT_SCHEMA`) and the
server accepts nothing below `minSchema: 5`; the bootstrap `contract` block
reports `{api: 4, minApi: 4, schema: 5, minSchema: 5}`. A client that passes
the upgrade gate (`api=4`) with a stored schema below `5` gets the
`version_gate` entry — the built-in "update required" surface — instead of
product screens, and its data is never destroyed (the quarantine rules above
still apply). The envelope of §1 and the runner rules of §3 are unchanged
except for the version numbers.

