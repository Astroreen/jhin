import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/store/versioned_store.dart';
import 'package:jhin/store/migrations/store_migrations.dart';

import 'fixtures.dart';

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;

  setUp(() {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
  });

  group('AppStorage envelope wiring (docs/updates.md §1)', () {
    test('profiles are written enveloped at the current schema', () async {
      await storage.addProfile(label: 'home', url: 'https://home.example');

      final stored = decodeStoredValue(prefs.values[StoreKeys.profiles])!;
      expect(stored.hasEnvelope, isTrue);
      expect(stored.schema, StoreMigrations.current);
      expect(stored.app, kJhinAppVersion);
      expect(stored.data, isA<List>());
      expect((stored.data as List).single['label'], 'home');
      // Round-trips through the enveloped read path.
      expect((await storage.readProfiles()).single.url, 'https://home.example');
    });

    test('activeProfileId is written enveloped and reads back', () async {
      final profile = await storage.addProfile(label: 'a', url: 'https://a');
      await storage.setActiveProfileId(profile.id);

      final stored =
          decodeStoredValue(prefs.values[StoreKeys.activeProfileId])!;
      expect(stored.hasEnvelope, isTrue);
      expect(stored.schema, StoreMigrations.current);
      expect(stored.data, profile.id);
      expect(await storage.readActiveProfileId(), profile.id);
    });

    test('a legacy bare-string activeProfileId still reads', () async {
      await prefs.write(StoreKeys.activeProfileId, 'legacy-1');
      expect(await storage.readActiveProfileId(), 'legacy-1');
    });

    test('a legacy un-enveloped profiles blob still reads with identical values',
        () async {
      await prefs.write(
        StoreKeys.profiles,
        jsonEncode([
          {'id': 'legacy-1', 'label': 'Home', 'url': 'https://jhin.example.org'}
        ]),
      );

      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(1));
      expect(profiles.single.id, 'legacy-1');
      expect(profiles.single.label, 'Home');
      expect(profiles.single.url, 'https://jhin.example.org');
    });

    test('malformed stored JSON never throws out of the store API', () async {
      await prefs.write(StoreKeys.profiles, '{not json at all');
      expect(await storage.readProfiles(), isEmpty);

      await prefs.write(StoreKeys.profiles,
          jsonEncode([{'label': 'no id'}]));
      expect(await storage.readProfiles(), isEmpty);

      await prefs.write(StoreKeys.activeProfileId, '{"broken":');
      expect(await storage.readActiveProfileId(), isNull);
    });

    test('the secure backend is never enveloped', () async {
      final profile =
          await storage.addProfile(label: 'a', url: 'https://a', token: 'device-token');

      final raw = await secrets.read('jhin.profileToken.${profile.id}');
      expect(raw, 'device-token'); // verbatim, no envelope
      expect(decodeStoredValue(raw)!.hasEnvelope, isFalse);
    });

    test('readData/writeData give every non-secure key the enveloped path',
        () async {
      await storage.writeEnvelope(StoreKeys.appearance, {
        'themeMode': 'dark',
        'textSize': 14,
        'density': 'comfortable',
        'panelMotionMs': 0,
      });
      expect(await storage.readData(StoreKeys.appearance), {
        'themeMode': 'dark',
        'textSize': 14,
        'density': 'comfortable',
        'panelMotionMs': 0,
      });
      expect(schemaOf(prefs, StoreKeys.appearance), StoreMigrations.current);

      // sessionState:<profileId> and commands.paletteHistory go through the
      // same enveloped path.
      await storage.writeEnvelope(StoreKeys.sessionState('p1'), {'stack': []});
      await storage.writeEnvelope(StoreKeys.paletteHistory, ['cmd']);
      expect(schemaOf(prefs, 'sessionState:p1'), StoreMigrations.current);
      expect(await storage.readData('sessionState:p1'), {'stack': []});
      expect(await storage.readData(StoreKeys.paletteHistory), ['cmd']);
    });
  });
}
