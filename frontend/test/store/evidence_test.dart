import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/store/migrations/migration_runner.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/store/versioned_store.dart';
import 'package:jhin/store/migrations/store_migrations.dart';

import 'fixtures.dart';

/// T54 evidence fixtures (scripts/qa/t54.sh).
///
/// Always asserts the three QA scenarios; when `T54_EVIDENCE_DIR` is set the
/// fixtures are also written there as JSON:
///
/// - `legacy-blob.json` — the real legacy (schema 1) on-disk state,
/// - `after-migration.json` — the same store after the runner,
/// - `quarantine.json` — the downgrade scenario (schema 9 kept safe).
void main() {
  group('T54 evidence fixtures', () {
    test('legacy blob migrates to schema 3 with identical data', () async {
      final prefs = InMemoryStringStore();
      final storage = memoryStorage(prefs: prefs);
      await seedLegacyStore(prefs);

      final legacy = _dump(prefs);
      final report = await MigrationRunner().run(storage);
      final after = _dumpParsed(prefs);

      expect(report.failures, 0);
      expect(report.migratedCount, 4);
      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(2));
      expect(profiles[0].id, 'legacy-1');
      expect(profiles[1].label, 'Work');
      expect(schemaOf(prefs, StoreKeys.profiles), StoreMigrations.current);
      expect(payloadOf(prefs, StoreKeys.profiles), jsonDecode(legacyProfilesRaw));
      expect(payloadOf(prefs, 'sessionState:legacy-1'),
          jsonDecode(legacySessionStateRaw));
      expect((payloadOf(prefs, StoreKeys.appearance) as Map)['themeMode'], 'dark');

      _write('legacy-blob.json', legacy);
      _write('after-migration.json', after);
    });

    test('a schema-9 blob is quarantined and the original survives', () async {
      final prefs = InMemoryStringStore();
      final storage = memoryStorage(prefs: prefs);
      final futureRaw = futureProfilesRaw();
      await prefs.write(StoreKeys.profiles, futureRaw);

      final report = await MigrationRunner().run(storage);

      expect(report.downgradedCount, 1);
      expect(prefs.values[StoreKeys.profiles], futureRaw);
      expect(prefs.values['migration.quarantine:jhin.profiles:9'], futureRaw);
      expect(await storage.readProfiles(), isEmpty);

      _write('quarantine.json', {
        'original': _parse(prefs.values[StoreKeys.profiles]),
        'copy': _parse(prefs.values['migration.quarantine:jhin.profiles:9']),
        'quarantineList': _parse(prefs.values[StoreKeys.quarantine] ?? '[]'),
      });
    });
  });
}

Map<String, String> _dump(InMemoryStringStore prefs) =>
    prefs.values.map((key, raw) => MapEntry(key, raw));

/// Parsed view of the store — the enveloped values readable as JSON.
Map<String, Object?> _dumpParsed(InMemoryStringStore prefs) =>
    prefs.values.map((key, raw) => MapEntry(key, _parse(raw)));

Object? _parse(String? raw) => raw == null ? null : jsonDecode(raw);

void _write(String name, Object? content) {
  final dir = Platform.environment['T54_EVIDENCE_DIR'];
  if (dir == null || dir.isEmpty) return;
  final encoder = const JsonEncoder.withIndent('  ');
  File('$dir/$name').writeAsStringSync(
      '${encoder.convert(content)}\n');
}
