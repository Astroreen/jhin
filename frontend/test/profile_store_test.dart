import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;

  setUp(() {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
  });

  group('ProfileStoreTest', () {
    test('add stores profiles without touching the active id', () async {
      final profile = await storage.addProfile(
        label: 'home',
        url: 'https://home.example:8443',
        certFingerprint: 'AA' * 32,
      );

      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(1));
      expect(profiles.single.id, profile.id);
      expect(profiles.single.label, 'home');
      expect(profiles.single.url, 'https://home.example:8443');
      expect(profiles.single.certFingerprint, 'AA' * 32);
      expect(await storage.readActiveProfileId(), isNull);
    });

    test('switch persists activeProfileId across instances', () async {
      final first = await storage.addProfile(label: 'a', url: 'https://a');
      final second = await storage.addProfile(label: 'b', url: 'https://b');

      await storage.setActiveProfileId(second.id);
      expect(await storage.readActiveProfileId(), second.id);

      final reloaded = AppStorage(prefs: prefs, secrets: secrets);
      expect(await reloaded.readActiveProfileId(), second.id);

      await reloaded.setActiveProfileId(first.id);
      final reloadedAgain = AppStorage(prefs: prefs, secrets: secrets);
      expect(await reloadedAgain.readActiveProfileId(), first.id);
    });

    test('remove drops the profile, its token and the active id', () async {
      final keep = await storage.addProfile(label: 'keep', url: 'https://keep');
      final drop = await storage.addProfile(
        label: 'drop',
        url: 'https://drop',
        token: 'secret-token',
      );
      await storage.setActiveProfileId(drop.id);

      await storage.removeProfile(drop.id);

      final profiles = await storage.readProfiles();
      expect(profiles, hasLength(1));
      expect(profiles.single.id, keep.id);
      expect(await storage.readActiveProfileId(), isNull);
      expect(await secrets.read('jhin.profileToken.${drop.id}'), isNull);
    });

    test('tokens live in the secure backend, not in the profile JSON', () async {
      final profile = await storage.addProfile(
        label: 'home',
        url: 'https://home.example:8443',
        token: 'device-token',
      );

      expect(prefs.values['jhin.profiles'], isNot(contains('device-token')));
      expect(await secrets.read('jhin.profileToken.${profile.id}'),
          'device-token');

      final reloaded = AppStorage(prefs: prefs, secrets: secrets);
      expect((await reloaded.readProfiles()).single.token, 'device-token');
    });

    test('update replaces fields and persists them', () async {
      final profile = await storage.addProfile(label: 'old', url: 'https://old');
      await storage.updateProfile(profile.copyWith(
        label: 'new',
        url: 'https://new',
        certFingerprint: 'BB' * 32,
      ));

      final reloaded = AppStorage(prefs: prefs, secrets: secrets);
      final updated = (await reloaded.readProfiles()).single;
      expect(updated.label, 'new');
      expect(updated.url, 'https://new');
      expect(updated.certFingerprint, 'BB' * 32);
    });
  });
}