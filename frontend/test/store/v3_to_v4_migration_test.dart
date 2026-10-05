import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/keyboard/palette.dart';
import 'package:jhin/store/migrations/migration_runner.dart';
import 'package:jhin/store/migrations/store_migrations.dart';
import 'package:jhin/store/migrations/v3_to_v4.dart';
import 'package:jhin/store/versioned_store.dart';

import 'fixtures.dart';

/// T85 (plan §15.6): the store schema migration 3→4, verified against a
/// copy of a real schema-3 store — the exact on-disk state a pre-T85
/// install writes (every key enveloped at schema 3, `appearance` without a
/// `themeId` field). The migration must seed the default theme id
/// (`t3-chat`) and lose nothing.
void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;

  /// A schema-3 envelope of [data], the shape the previous build wrote.
  String schema3Envelope(Object? data) => jsonEncode({
        'schema': 3,
        'app': kJhinAppVersion,
        'writtenAt': '2026-09-01T12:00:00Z',
        'data': data,
      });

  /// Seeds the store with a full real schema-3 state and returns the raw
  /// dump (the "copy of a real store file" the assertions compare against).
  Map<String, String> seedRealSchema3Store() {
    final state = <String, Object?>{
      StoreKeys.profiles: [
        {
          'id': 'home',
          'label': 'Home',
          'url': 'https://jhin.example.org',
          'certFingerprint': null,
        },
        {'id': 'work', 'label': 'Work', 'url': 'https://work.example:8443'},
      ],
      StoreKeys.activeProfileId: 'home',
      StoreKeys.sessionState('home'): {
        'stack': ['screen:chat'],
        'cache': {'sidebar': 'collapsed'},
      },
      // The real pre-T85 appearance: no themeId field.
      StoreKeys.appearance: {
        'themeMode': 'dark',
        'textSize': 14,
        'density': 'comfortable',
        'panelMotionMs': 120,
      },
      StoreKeys.keybindings: {
        'rules': [
          {'command': 'composer.send', 'keys': 'mod+shift+enter'},
        ],
      },
      StoreKeys.tokensEtag: {'etag': 'W/"abc"'},
      StoreKeys.paletteHistory: ['palette.open', 'thread.new'],
    };
    state.forEach((key, data) => prefs.write(key, schema3Envelope(data)));
    return prefs.values;
  }

  setUp(() {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
  });

  group('schema 3→4: themeId persistence (T85)', () {
    test('the chain is 1→2→3→4 and the current schema is 4', () {
      expect(StoreMigrations.current, 4);
      expect(
          StoreMigrations.steps.map((s) => '${s.from}→${s.to}'),
          containsAllInOrder(['2→3', '3→4']));
    });

    test('a real schema-3 store gains themeId t3-chat and loses nothing',
        () async {
      final before = seedRealSchema3Store();

      final report = await MigrationRunner().run(storage);

      expect(report.failures, 0);
      expect(schemaOf(prefs, StoreKeys.appearance), StoreMigrations.current);

      // The appearance payload: the default theme id merged in, every
      // pre-existing field intact.
      final appearance = payloadOf(prefs, StoreKeys.appearance) as Map;
      expect(appearance['themeId'], V3ToV4.defaultThemeId);
      expect(appearance['themeId'], 't3-chat');
      expect(appearance['themeMode'], 'dark');
      expect(appearance['textSize'], 14);
      expect(appearance['density'], 'comfortable');
      expect(appearance['panelMotionMs'], 120);

      // No data loss anywhere else: every other key keeps its exact payload.
      expect(payloadOf(prefs, StoreKeys.profiles),
          jsonDecode(before[StoreKeys.profiles]!)['data']);
      expect(payloadOf(prefs, StoreKeys.activeProfileId), 'home');
      expect(payloadOf(prefs, StoreKeys.sessionState('home')), {
        'stack': ['screen:chat'],
        'cache': {'sidebar': 'collapsed'},
      });
      expect(payloadOf(prefs, StoreKeys.keybindings), {
        'rules': [
          {'command': 'composer.send', 'keys': 'mod+shift+enter'},
        ],
      });
      expect(payloadOf(prefs, StoreKeys.tokensEtag), {'etag': 'W/"abc"'});
      expect(payloadOf(prefs, StoreKeys.paletteHistory),
          ['palette.open', 'thread.new']);
    });

    test('an appearance that already carries a themeId is never clobbered',
        () async {
      await prefs.write(
          StoreKeys.appearance,
          schema3Envelope({
            'themeMode': 'light',
            'themeId': 'ocean',
          }));

      await MigrationRunner().run(storage);

      final appearance = payloadOf(prefs, StoreKeys.appearance) as Map;
      expect(appearance['themeId'], 'ocean');
      expect(appearance['themeMode'], 'light');
    });

    test('a fresh store seeds appearance through the 2→3 defaults and the '
        'reader default answers t3-chat', () async {
      await MigrationRunner().run(storage);

      // The 2→3 step seeds the key (it predates the themeId field); the
      // seeded payload stays untouched by 3→4 — the reader default covers it.
      final appearance = payloadOf(prefs, StoreKeys.appearance) as Map;
      expect(appearance.containsKey('themeId'), isFalse);
      expect(AppearancePrefs.defaultThemeId, 't3-chat');
      expect((await AppearancePrefs.read(storage))['themeId'], 't3-chat');
    });
  });
}
