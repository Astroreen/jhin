import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/store/migrations/migration_runner.dart';
import 'package:jhin/store/versioned_store.dart';
import 'package:jhin/store/migrations/store_migrations.dart';

import 'fixtures.dart';

/// A real schema-2 envelope (the shape the pre-keybindings app wrote).
String schema2Envelope(Object? data) => jsonEncode({
      'schema': 2,
      'app': '0.0.9',
      'writtenAt': '2026-01-01T00:00:00Z',
      'data': data,
    });

void main() {
  late InMemoryStringStore prefs;
  late AppStorage storage;

  setUp(() {
    prefs = InMemoryStringStore();
    storage = memoryStorage(prefs: prefs);
  });

  group('schema:2 store blob missing keybindings (T70 acceptance)', () {
    test('v2_to_v3 seeds keybindings without clobbering the other keys',
        () async {
      // The real on-disk shape at schema 2: profiles, the active id, the
      // per-profile session state and the legacy theme — no `keybindings`.
      const profiles = [
        {'id': 'p1', 'label': 'Home', 'url': 'https://jhin.example.org'},
        {'id': 'p2', 'label': 'Work', 'url': 'https://work.example:8443'},
      ];
      const sessionState = {
        'stack': ['screen:settings'],
        'cache': {'sidebar': 'collapsed'},
      };
      await prefs.write(StoreKeys.profiles, schema2Envelope(profiles));
      await prefs.write(
          StoreKeys.activeProfileId, schema2Envelope('p1'));
      await prefs.write(
          StoreKeys.sessionState('p1'), schema2Envelope(sessionState));
      await prefs.write(
          StoreKeys.legacyTheme, schema2Envelope({'mode': 'dark'}));

      final report = await MigrationRunner().run(storage);

      // The step seeds keybindings only when absent.
      expect(report.seededKeys, contains(StoreKeys.keybindings));
      expect(schemaOf(prefs, StoreKeys.keybindings), StoreMigrations.current);
      expect(payloadOf(prefs, StoreKeys.keybindings), {'rules': []});

      // Every pre-existing key keeps its exact data — never clobbered.
      expect(payloadOf(prefs, StoreKeys.profiles), profiles);
      expect(payloadOf(prefs, StoreKeys.activeProfileId), 'p1');
      expect(payloadOf(prefs, StoreKeys.sessionState('p1')), sessionState);
      expect(payloadOf(prefs, StoreKeys.legacyTheme), {'mode': 'dark'});
    });

    test('an existing keybindings blob keeps its rules while the rest '
        'migrates', () async {
      const profiles = [
        {'id': 'p1', 'label': 'Home', 'url': 'https://jhin.example.org'},
      ];
      await prefs.write(StoreKeys.profiles, schema2Envelope(profiles));
      await prefs.write(
          StoreKeys.activeProfileId, schema2Envelope('p1'));
      await prefs.write(StoreKeys.keybindings, schema2Envelope({
        'rules': [
          {'command': 'composer.send', 'keys': 'mod+shift+enter'}
        ]
      }));

      final report = await MigrationRunner().run(storage);

      expect(report.seededKeys, isNot(contains(StoreKeys.keybindings)));
      expect(payloadOf(prefs, StoreKeys.keybindings), {
        'rules': [
          {'command': 'composer.send', 'keys': 'mod+shift+enter'}
        ]
      });
      expect(payloadOf(prefs, StoreKeys.profiles), profiles);
    });
  });
}
