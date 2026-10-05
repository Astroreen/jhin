import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/keyboard/composer_commands.dart';
import 'package:jhin/store/versioned_store.dart';
import 'package:jhin/store/migrations/store_migrations.dart';

/// T68 composer history store: the per-profile sent-prompt history is
/// enveloped at the current schema under `composer.history:<profileId>`.
void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;

  setUp(() {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
  });

  test('T68 history: entries persist enveloped at the current schema', () async {
    final history =
        ComposerHistory(storage: storage, profileId: 'profile-a');
    await history.add('first');
    await history.add('second');

    final raw = await storage.readRaw('composer.history:profile-a');
    expect(raw, isNotNull);
    final envelope = jsonDecode(raw!) as Map<String, dynamic>;
    expect(envelope['schema'], StoreMigrations.current);
    expect((envelope['data'] as Map)['entries'], ['first', 'second']);

    final reloaded =
        ComposerHistory(storage: storage, profileId: 'profile-a');
    expect(await reloaded.load(), ['first', 'second']);
    expect(reloaded.key, 'composer.history:profile-a');
    expect(StoreKeys.composerHistory('profile-a'), 'composer.history:profile-a');
  });

  test('T68 history: per-profile isolation (profile A invisible in '
      'profile B)', () async {
    final profileA = ComposerHistory(storage: storage, profileId: 'a');
    await profileA.add('profile a prompt');

    final profileB = ComposerHistory(storage: storage, profileId: 'b');
    expect(await profileB.load(), isEmpty);
    expect(await profileA.load(), ['profile a prompt']);
  });

  test('T68 history: no consecutive duplicates and bounded size', () async {
    final history =
        ComposerHistory(storage: storage, profileId: 'profile-a');
    await history.add('same');
    await history.add('same');
    await history.add('other');
    expect(await history.load(), ['same', 'other']);

    final tiny = ComposerHistory(
        storage: storage, profileId: 'tiny', maxEntries: 2);
    await tiny.add('one');
    await tiny.add('two');
    await tiny.add('three');
    expect(await tiny.load(), ['two', 'three']);
  });
}
