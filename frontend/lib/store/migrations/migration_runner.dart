import '../../core/auth/app_storage.dart';
import '../versioned_store.dart';
import 'store_migration.dart';
import 'store_migrations.dart';

/// Outcome of one key's migration.
enum KeyOutcome {
  /// Migrated forward to the current schema (§3 rule 2).
  migrated,

  /// Already at the current schema — untouched.
  current,

  /// Migration threw; the key keeps its last good value and is recorded in
  /// `migration.quarantine` (§3 rules 2 and 4).
  quarantined,

  /// Written by a newer schema; copied to
  /// `migration.quarantine:<key>:<schema>`, original untouched (§3 rule 3).
  downgraded,

  /// Introduced by a step and seeded (absent before, never clobbering).
  seeded,
}

/// What happened to one key during a run.
final class KeyMigrationResult {
  const KeyMigrationResult({
    required this.key,
    required this.fromSchema,
    required this.toSchema,
    required this.outcome,
    this.error,
  });

  final String key;
  final int fromSchema;
  final int toSchema;
  final KeyOutcome outcome;

  /// The error when [outcome] is [KeyOutcome.quarantined].
  final Object? error;
}

/// What a migration run did (docs/updates.md §2): the per-key results plus
/// the counts. `main()` awaits it before `JhinApp` builds (§3 rule 5).
final class MigrationReport {
  MigrationReport({List<KeyMigrationResult> results = const []}) {
    _results.addAll(results);
  }

  final List<KeyMigrationResult> _results = [];

  /// Per-key results in processing order.
  List<KeyMigrationResult> get results => List.unmodifiable(_results);

  void _add(KeyMigrationResult result) => _results.add(result);

  /// Keys migrated forward to the current schema.
  List<String> get migratedKeys =>
      _of(KeyOutcome.migrated).map((r) => r.key).toList();

  /// Keys whose migration threw (kept their last good value).
  List<String> get quarantinedKeys =>
      _of(KeyOutcome.quarantined).map((r) => r.key).toList();

  /// Keys quarantined because a newer schema wrote them (rule 3).
  List<String> get newerQuarantined =>
      _of(KeyOutcome.downgraded).map((r) => r.key).toList();

  /// Keys seeded by a step's `introduced()` defaults.
  List<String> get seededKeys =>
      _of(KeyOutcome.seeded).map((r) => r.key).toList();

  /// Number of failed (quarantined) migrations.
  int get failures => _of(KeyOutcome.quarantined).length;

  /// Number of successful forward migrations.
  int get migratedCount => _of(KeyOutcome.migrated).length;

  /// Number of newer-schema keys quarantined (downgrade protection).
  int get downgradedCount => _of(KeyOutcome.downgraded).length;

  /// Number of keys already at the current schema.
  int get currentCount => _of(KeyOutcome.current).length;

  List<KeyMigrationResult> _of(KeyOutcome outcome) =>
      _results.where((r) => r.outcome == outcome).toList();
}

/// Applies the migration chain to the persisted store (docs/updates.md §3).
///
/// The six rules, verbatim:
///
/// 1. **Precedent:** on first read, a key without an envelope is legacy
///    `schema 1` (the current on-disk shape) — wrapped and migrated.
/// 2. **Ordered, atomic per key:** apply `from→to` steps in order; before
///    mutating, copy the raw value to `migration.backup:<key>`; on success
///    write the enveloped value and delete the backup; on throw, restore
///    the backup and record the key in `migration.quarantine`.
/// 3. **Forward data (downgrade):** if `envelope.schema > current`, do NOT
///    touch the value. Copy it to `migration.quarantine:<key>:<schema>` and
///    keep the app running on defaults. Never destroy newer data.
/// 4. **Partial failure is survivable:** one failing key quarantines
///    itself; other keys still migrate; the app boots.
/// 5. **Runs before anything reads state:** `main()` awaits the
///    [MigrationReport] before `JhinApp` builds.
/// 6. **Version gate:** `contract.minSchema` from bootstrap + `schema` on
///    disk determine the "update required" surface (see
///    `boot/version_gate.dart`).
final class MigrationRunner {
  MigrationRunner({List<StoreMigration>? steps, String? appVersion})
      : _steps = steps ?? StoreMigrations.steps,
        _appVersion = appVersion ?? kJhinAppVersion;

  final List<StoreMigration> _steps;
  final String _appVersion;

  /// Runs the chain over every persisted data key. Never throws: a failing
  /// key quarantines itself and the run completes (rule 4).
  Future<MigrationReport> run(AppStorage storage) async {
    final report = MigrationReport();
    final current = StoreMigrations.current;

    final candidates = await _candidateKeys(storage);

    // Crash recovery (§4): a backup left behind means the last run died
    // between the backup write and the commit/restore — put the raw value
    // back and drop the backup. Re-running the chain over the restored
    // value converges.
    for (final key in candidates) {
      final backup = await storage.readRaw(StoreKeys.backup(key));
      if (backup != null) {
        await storage.writeRaw(key, backup);
        await storage.deleteKey(StoreKeys.backup(key));
      }
    }

    // Pre-migration snapshot: raw values and decoded payloads. The steps'
    // [StoreLookup] reads this snapshot, so a step sees the pre-migration
    // state of the other keys.
    final raws = <String, String?>{};
    final data = <String, Object?>{};
    for (final key in candidates) {
      final raw = await storage.readRaw(key);
      raws[key] = raw;
      final stored = decodeStoredValue(raw);
      if (stored != null) data[key] = stored.data;
    }
    final lookup = _SnapshotLookup(raws, data);
    var quarantineChanged = false;

    // The quarantine list (§4) — persisted, enveloped, bookkeeping.
    final quarantined = _readQuarantineList(
        decodeStoredValue(await storage.readRaw(StoreKeys.quarantine))?.data);
    final written = <String>{};

    // Rule 2 + rule 3 + rule 4: per-key, ordered, atomic.
    for (final key in candidates) {
      final raw = raws[key];
      if (raw == null || raw.isEmpty) continue;
      final stored = decodeStoredValue(raw)!;

      // Rule 3: forward data (downgrade) — never touch, copy to quarantine.
      if (stored.schema > current) {
        final copyKey = StoreKeys.quarantineCopy(key, stored.schema);
        if (await storage.readRaw(copyKey) == null) {
          await storage.writeRaw(copyKey, raw);
        }
        report._add(KeyMigrationResult(
          key: key,
          fromSchema: stored.schema,
          toSchema: stored.schema,
          outcome: KeyOutcome.downgraded,
        ));
        continue;
      }

      // Already at the current schema — nothing to do.
      if (stored.schema == current) {
        report._add(KeyMigrationResult(
          key: key,
          fromSchema: current,
          toSchema: current,
          outcome: KeyOutcome.current,
        ));
        continue;
      }

      // Rule 2: ordered, atomic per key.
      await storage.writeRaw(StoreKeys.backup(key), raw);
      try {
        var payload = stored.data;
        final sideWrites = <String, Object?>{};
        for (final step in _steps) {
          if (step.from < stored.schema) continue; // ordered: from→to in list order
          if (payload is Map<String, dynamic>) step.upgrade(payload);
          sideWrites.addAll(step.sideKeys(key, payload, lookup));
        }
        final enveloped = encodeStoredValue(
            schema: current, app: _appVersion, data: payload);
        await storage.writeRaw(key, enveloped);
        written.add(key);
        for (final entry in sideWrites.entries) {
          await storage.writeRaw(
            entry.key,
            encodeStoredValue(
                schema: current, app: _appVersion, data: entry.value),
          );
          written.add(entry.key);
        }
        await storage.deleteKey(StoreKeys.backup(key));
        report._add(KeyMigrationResult(
          key: key,
          fromSchema: stored.schema,
          toSchema: current,
          outcome: KeyOutcome.migrated,
        ));
        if (quarantined.remove(key)) quarantineChanged = true;
      } catch (error) {
        // Rule 2 on throw: restore the backup (the last good value) and
        // record the key in `migration.quarantine`. The backup is dropped
        // after the restore — a backup left behind means the process died
        // mid-run (handled by the recovery pass above).
        await storage.writeRaw(key, raw);
        await storage.deleteKey(StoreKeys.backup(key));
        if (!quarantined.contains(key)) {
          quarantined.add(key);
          quarantineChanged = true;
        }
        report._add(KeyMigrationResult(
          key: key,
          fromSchema: stored.schema,
          toSchema: stored.schema,
          outcome: KeyOutcome.quarantined,
          error: error,
        ));
      }
    }

    // Introduced keys: seed when absent, never clobber (§5, step 2→3).
    for (final step in _steps) {
      for (final entry in step.introduced().entries) {
        if (raws[entry.key] != null || written.contains(entry.key)) continue;
        await storage.writeRaw(
          entry.key,
          encodeStoredValue(
              schema: current, app: _appVersion, data: entry.value),
        );
        written.add(entry.key);
        report._add(KeyMigrationResult(
          key: entry.key,
          fromSchema: 0,
          toSchema: step.to,
          outcome: KeyOutcome.seeded,
        ));
      }
    }

    if (quarantineChanged) {
      await storage.writeRaw(
        StoreKeys.quarantine,
        encodeStoredValue(
            schema: current, app: _appVersion, data: quarantined),
      );
    }
    return report;
  }

  /// The data keys the runner inspects: the fixed key set plus one
  /// `sessionState:<profileId>` key per stored profile. Bookkeeping keys
  /// (`migration.*`) are never migrated as data.
  Future<List<String>> _candidateKeys(AppStorage storage) async {
    final keys = <String>{
      StoreKeys.profiles,
      StoreKeys.activeProfileId,
      StoreKeys.legacySessionState,
      StoreKeys.appearance,
      StoreKeys.keybindings,
      StoreKeys.tokensEtag,
      StoreKeys.paletteHistory,
      StoreKeys.legacyTheme,
    };
    final stored =
        decodeStoredValue(await storage.readRaw(StoreKeys.profiles));
    final profiles = stored?.data;
    if (profiles is List) {
      for (final item in profiles) {
        if (item is Map && item['id'] is String) {
          keys.add(StoreKeys.sessionState(item['id'] as String));
        }
      }
    }
    return keys.where((key) => !StoreKeys.isBookkeeping(key)).toList()
      ..sort();
  }

  /// Reads the persisted quarantine list; malformed values degrade to an
  /// empty list — never throws.
  List<String> _readQuarantineList(Object? data) {
    if (data is List) {
      return [for (final item in data) if (item is String) item];
    }
    return <String>[];
  }
}

/// [StoreLookup] over the pre-migration snapshot.
final class _SnapshotLookup implements StoreLookup {
  _SnapshotLookup(this._raws, this._data);

  final Map<String, String?> _raws;
  final Map<String, Object?> _data;

  @override
  Object? data(String key) => _data[key];

  @override
  bool exists(String key) => _raws[key] != null;
}
