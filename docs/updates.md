# Jhin data-upgrade system

When the app version changes and new data or code lands, the client inspects
its old persisted data and *transforms it* so it keeps working — exactly how
normal app update systems behave. This document is **normative** for the
persisted-state half of that system (the wire/payload half — `api`
negotiation and cached-payload versioning — lives in
[sdui.md](sdui.md) sections 6 and 8). Two versioned surfaces, one runner
model.

## 1. Persisted-key envelope

Every non-secure persisted key in `AppStorage`/`SharedPreferences` gets an
**envelope**:

```json
{
  "schema": 3,
  "app": "0.3.0",
  "writtenAt": "2026-10-03T09:30:00Z",
  "data": {
    "profiles": [
      { "id": "home", "url": "https://jhin.example.org", "label": "Home" }
    ],
    "activeProfileId": "home"
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

**Precedent:** a stored value with no envelope is legacy `schema 1` (the
current on-disk shape) — it is wrapped and migrated on first read.

Current keys and their owners: `profiles` (list of `ServerProfile`: url,
label, certFingerprint, tokenRef, cachedBootstrap, cachedScreens, fallbacks),
`activeProfileId`, `sessionState:<profileId>` (screen stack + cache),
`appearance` (themeMode, textSize, density, panelMotionMs), `keybindings`
(user override rules), `commands.paletteHistory`, `migration.quarantine`.
**Secure storage (`flutter_secure_storage`) is NOT enveloped** — device
tokens are opaque and version-independent.

## 2. StoreMigration API

Migration model (`frontend/lib/store/`):

```dart
abstract class StoreMigration {
  int get from; int get to;
  void upgrade(Map<String, dynamic> data);   // in-place transform of the `data` blob
}
final class StoreMigrations {
  static const current = 3;
  static final List<StoreMigration> steps = [ _V1ToV2(), _V2ToV3() ];
}
final class MigrationRunner {
  Future<MigrationReport> run(AppStorage storage);  // see rules below
}
```

`MigrationReport` carries what happened: the keys migrated, the keys
quarantined and the number of failures. `main()` awaits it before `JhinApp`
builds.

## 3. The six runner rules

All tested. Stated verbatim; every implementation and future step must
satisfy them exactly.

1. **Precedent:** on first read, a key without an envelope is legacy
   `schema 1` (the current on-disk shape) — wrapped and migrated.
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
5. **Runs before anything reads state:** `main()` awaits `MigrationReport`
   before `JhinApp` builds; failures surface in `BootError`-style UI but
   never block launch.
6. **Version gate:** `contract.minSchema` from bootstrap + `schema` on disk
   determine the "update required" surface; it is a *client-owned* screen
   (allowed by C-10 — it is chrome, not product).

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

`StoreMigrations.current` is `3`. The steps defined so far:

| Step | What it does |
|------|--------------|
| 1 → 2 | wrap legacy blobs into the envelope and split `sessionState` per profile |
| 2 → 3 | introduce `appearance` + `keybindings` + `tokensEtag` and migrate the old `theme` key into `appearance` |

## 6. How to add a migration step

1. Bump `StoreMigrations.current` to the new schema version `N + 1`.
2. Write `frontend/lib/store/migrations/v<N>_to_v<N+1>.dart`: a
   `StoreMigration` with `from = N`, `to = N + 1` and an `upgrade()` that
   transforms the `data` blob **in place** (mutate the map; do not return a
   new one).
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
new is needed there; this document covers client-persisted state only.
