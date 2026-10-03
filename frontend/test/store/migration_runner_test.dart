import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/store/migrations/migration_runner.dart';
import 'package:jhin/store/migrations/store_migration.dart';
import 'package:jhin/store/migrations/store_migrations.dart';
import 'package:jhin/store/migrations/v1_to_v2.dart';
import 'package:jhin/store/versioned_store.dart';

import 'fixtures.dart';

/// A [StringStore] that records every operation in order — proves the
/// backup → transform → commit → cleanup sequence of rule 2.
final class RecordingStore implements StringStore {
  final InMemoryStringStore _inner = InMemoryStringStore();
  final List<String> ops = [];

  /// Snapshot of the stored values (for assertions in tests).
  Map<String, String> get values => _inner.values;

  @override
  Future<String?> read(String key) async => _inner.read(key);

  @override
  Future<void> write(String key, String value) async {
    ops.add('write:$key');
    await _inner.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    ops.add('delete:$key');
    await _inner.delete(key);
  }
}

/// A step that throws on a marked payload — the monkey-patched failing
/// migration of the partial-failure and quarantine tests.
final class ThrowingStep extends StoreMigration {
  @override
  int get from => 2;

  @override
  int get to => 3;

  @override
  void upgrade(Map<String, dynamic> data) {
    if (data['boom'] == true) throw StateError('boom');
  }
}

/// Steps that record their invocation order.
final class RecordingStep extends StoreMigration {
  RecordingStep(this.fromSchema, this.toSchema, this.log);

  final int fromSchema;
  final int toSchema;
  final List<String> log;

  @override
  int get from => fromSchema;

  @override
  int get to => toSchema;

  @override
  void upgrade(Map<String, dynamic> data) =>
      log.add('upgrade:${fromSchema}to$toSchema');
}

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;

  setUp(() {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
  });

  group('MigrationRunner rules (docs/updates.md §3)', () {
    test(
      'rule 1: a key without an envelope is legacy schema 1 — wrapped and migrated',
      () async {
        await seedLegacyStore(prefs);

        final report = await MigrationRunner().run(storage);

        expect(schemaOf(prefs, StoreKeys.profiles), 3);
        expect(schemaOf(prefs, StoreKeys.activeProfileId), 3);
        expect(payloadOf(prefs, StoreKeys.activeProfileId), 'legacy-1');
        expect(await storage.readActiveProfileId(), 'legacy-1');
        expect(report.migratedKeys, containsAll(
            [StoreKeys.profiles, StoreKeys.activeProfileId]));
      },
    );

    test('rule 2: steps apply in list order (ordered)', () async {
      await prefs.write(StoreKeys.legacyTheme, legacyThemeRaw);
      final log = <String>[];
      final runner = MigrationRunner(steps: [
        RecordingStep(1, 2, log),
        RecordingStep(2, 3, log),
      ]);

      await runner.run(storage);

      expect(log, ['upgrade:1to2', 'upgrade:2to3']);
    });

    test('rule 2: backup → commit → backup deleted (atomic, success)',
        () async {
      final recording = RecordingStore();
      final recordingStorage =
          AppStorage(prefs: recording, secrets: secrets);
      await recording.write(StoreKeys.profiles, legacyProfilesRaw);
      final opsBefore = recording.ops.length;

      await MigrationRunner().run(recordingStorage);

      final runOps = recording.ops.sublist(opsBefore);
      final backupWrite = runOps.indexOf('write:migration.backup:jhin.profiles');
      final commit = runOps.lastIndexOf('write:jhin.profiles');
      final backupDelete = runOps.indexOf('delete:migration.backup:jhin.profiles');
      expect(backupWrite, greaterThanOrEqualTo(0));
      expect(commit, greaterThan(backupWrite),
          reason: 'the enveloped commit comes after the backup write');
      expect(backupDelete, greaterThan(commit),
          reason: 'the backup is deleted after the commit');
      expect(recording.values['migration.backup:jhin.profiles'], isNull);
    });

    test(
      'rule 2: on throw the backup is restored, the backup is gone and the key is quarantined',
      () async {
        await prefs.write(StoreKeys.legacyTheme, '{"boom":true,"mode":"dark"}');
        final runner = MigrationRunner(steps: [V1ToV2(), ThrowingStep()]);

        final report = await runner.run(storage);

        // The key keeps its last good value (restored raw).
        expect(prefs.values[StoreKeys.legacyTheme], '{"boom":true,"mode":"dark"}');
        // The backup is gone.
        expect(prefs.values['migration.backup:theme'], isNull);
        // The key is recorded in migration.quarantine (persisted, enveloped).
        expect(payloadOf(prefs, StoreKeys.quarantine), ['theme']);
        expect(schemaOf(prefs, StoreKeys.quarantine), 3);
        expect(report.quarantinedKeys, ['theme']);
        expect(report.failures, 1);
      },
    );

    test(
      'rule 3: a newer schema is copied to quarantine, the original is never destroyed',
      () async {
        final futureRaw = futureProfilesRaw();
        await prefs.write(StoreKeys.profiles, futureRaw);

        final report = await MigrationRunner().run(storage);

        // The original value is untouched, byte for byte.
        expect(prefs.values[StoreKeys.profiles], futureRaw);
        // A copy landed in the downgrade quarantine.
        expect(prefs.values['migration.quarantine:jhin.profiles:9'], futureRaw);
        expect(report.newerQuarantined, [StoreKeys.profiles]);
        expect(report.downgradedCount, 1);
        expect(report.failures, 0);
        // The app keeps running on defaults for that key.
        expect(await storage.readProfiles(), isEmpty);
        // No backup was written for a downgraded key.
        expect(prefs.values['migration.backup:jhin.profiles'], isNull);
      },
    );

    test(
      'rule 4: one failing key quarantines itself; other keys still migrate',
      () async {
        await seedLegacyStore(prefs);
        await prefs.write(StoreKeys.legacyTheme, '{"boom":true,"mode":"dark"}');
        final runner = MigrationRunner(steps: [V1ToV2(), ThrowingStep()]);

        final report = await runner.run(storage);

        // The failing key is quarantined…
        expect(report.failures, 1);
        expect(report.quarantinedKeys, ['theme']);
        expect(prefs.values[StoreKeys.legacyTheme], '{"boom":true,"mode":"dark"}');
        // …and every other key still migrated.
        expect(schemaOf(prefs, StoreKeys.profiles), 3);
        expect(schemaOf(prefs, StoreKeys.activeProfileId), 3);
        expect(report.migratedKeys,
            containsAll([StoreKeys.profiles, StoreKeys.activeProfileId]));
        // The app boots: profiles read cleanly.
        expect((await storage.readProfiles()).length, 2);
      },
    );

    test('rule 5: the report is produced before the first read', () async {
      await seedLegacyStore(prefs);

      // main() awaits exactly this before JhinApp builds; the read below
      // must observe the migrated store.
      final report = await MigrationRunner().run(storage);
      final profiles = await storage.readProfiles();

      expect(report.migratedCount, greaterThanOrEqualTo(2));
      expect(profiles, hasLength(2));
      expect(profiles.first.label, 'Home');
      expect(profiles.first.url, 'https://jhin.example.org');
      expect(profiles.last.id, 'legacy-2');
    });
  });

  group('MigrationRunner schema steps (docs/updates.md §5)', () {
    test('full chain: the real legacy profiles blob migrates 1→2→3 with identical data',
        () async {
      await seedLegacyStore(prefs);

      await MigrationRunner().run(storage);

      final stored = decodeStoredValue(prefs.values[StoreKeys.profiles])!;
      expect(stored.hasEnvelope, isTrue);
      expect(stored.schema, StoreMigrations.current);
      expect(stored.app, kJhinAppVersion);
      // Identical data at schema 3.
      expect(stored.data, jsonDecode(legacyProfilesRaw));
      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(2));
      expect(profiles[0].id, 'legacy-1');
      expect(profiles[0].certFingerprint, 'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA');
      expect(profiles[1].label, 'Work');
    });

    test('step 1→2 splits the legacy sessionState per profile', () async {
      await seedLegacyStore(prefs);

      final report = await MigrationRunner().run(storage);

      final target = StoreKeys.sessionState('legacy-1');
      expect(schemaOf(prefs, target), 3);
      expect(payloadOf(prefs, target), jsonDecode(legacySessionStateRaw));
      // The legacy key is never destroyed — it stays, enveloped.
      expect(schemaOf(prefs, StoreKeys.legacySessionState), 3);
      expect(payloadOf(prefs, StoreKeys.legacySessionState),
          jsonDecode(legacySessionStateRaw));
      expect(report.migratedKeys, contains(StoreKeys.legacySessionState));
    });

    test('step 2→3 migrates the old theme key into appearance', () async {
      await prefs.write(StoreKeys.legacyTheme, legacyThemeRaw);

      await MigrationRunner().run(storage);

      expect(schemaOf(prefs, StoreKeys.appearance), 3);
      expect(payloadOf(prefs, StoreKeys.appearance), {
        'themeMode': 'dark',
        'textSize': 14,
        'density': 'comfortable',
        'panelMotionMs': 0,
      });
      // The legacy theme key is never destroyed.
      expect(schemaOf(prefs, StoreKeys.legacyTheme), 3);
      expect(payloadOf(prefs, StoreKeys.legacyTheme), {'mode': 'dark'});
    });

    test('step 2→3 seeds keybindings without clobbering an existing file',
        () async {
      final existing = jsonEncode({
        'schema': 2,
        'app': '0.1.0',
        'writtenAt': '2026-01-01T00:00:00Z',
        'data': {
          'rules': [
            {'command': 'composer.send', 'keys': 'mod+shift+enter'}
          ]
        },
      });
      await prefs.write(StoreKeys.keybindings, existing);

      await MigrationRunner().run(storage);

      expect(schemaOf(prefs, StoreKeys.keybindings), 3);
      expect(payloadOf(prefs, StoreKeys.keybindings), {
        'rules': [
          {'command': 'composer.send', 'keys': 'mod+shift+enter'}
        ]
      });
    });

    test('step 2→3 introduces appearance, keybindings and tokensEtag when absent',
        () async {
      await MigrationRunner().run(storage);

      expect(payloadOf(prefs, StoreKeys.appearance), {
        'themeMode': 'system',
        'textSize': 14,
        'density': 'comfortable',
        'panelMotionMs': 0,
      });
      expect(payloadOf(prefs, StoreKeys.keybindings), {'rules': []});
      expect(payloadOf(prefs, StoreKeys.tokensEtag), {'etag': ''});
      expect(schemaOf(prefs, StoreKeys.appearance), 3);
    });

    test('a quarantined key migrates on a later healthy run and leaves the list',
        () async {
      await prefs.write(StoreKeys.legacyTheme, '{"boom":true,"mode":"dark"}');

      final failing = MigrationRunner(steps: [V1ToV2(), ThrowingStep()]);
      await failing.run(storage);
      expect(payloadOf(prefs, StoreKeys.quarantine), ['theme']);

      // A later run without the throwing step migrates the key and clears it.
      await MigrationRunner().run(storage);
      expect(schemaOf(prefs, StoreKeys.legacyTheme), 3);
      expect(payloadOf(prefs, StoreKeys.quarantine), isEmpty);
    });

    test('a backup left behind by a crash is restored before migrating',
        () async {
      await seedLegacyStore(prefs);
      // Simulate a crash between the backup write and the commit.
      await prefs.write('migration.backup:jhin.profiles', legacyProfilesRaw);

      final report = await MigrationRunner().run(storage);

      expect(prefs.values['migration.backup:jhin.profiles'], isNull);
      expect(schemaOf(prefs, StoreKeys.profiles), 3);
      expect(report.failures, 0);
    });

    test('a fresh store is seeded and the run never throws', () async {
      final report = await MigrationRunner().run(storage);

      expect(report.failures, 0);
      expect(report.seededKeys,
          containsAll([StoreKeys.appearance, StoreKeys.keybindings]));
      expect(await storage.readProfiles(), isEmpty);
      expect(await storage.readActiveProfileId(), isNull);
    });
  });
}
