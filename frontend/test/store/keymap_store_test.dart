// ignore_for_file: avoid_print — the T70 QA script tees these transcripts.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/keyboard/keymap.dart';
import 'package:jhin/store/versioned_store.dart';

import 'fixtures.dart';

void main() {
  late InMemoryStringStore prefs;
  late AppStorage storage;

  setUp(() {
    prefs = InMemoryStringStore();
    storage = memoryStorage(prefs: prefs);
  });

  group('KeymapStore (T70)', () {
    test('load on a fresh store yields no overrides (server defaults stay active)',
        () async {
      final store = KeymapStore(storage);
      await store.load();
      expect(store.rules, isEmpty);
      expect(store.byCommand, isEmpty);
    });

    test('setOverride persists the enveloped store shape and survives a restart',
        () async {
      final store = KeymapStore(storage);
      await store.load();
      await store.setOverride('composer.send', 'mod+shift+enter');

      // Store shape is the schema 3 envelope around {'rules': [...]}
      // (docs/updates.md §1).
      expect(schemaOf(prefs, StoreKeys.keybindings), 3);
      expect(payloadOf(prefs, StoreKeys.keybindings), {
        'rules': [
          {'command': 'composer.send', 'keys': 'mod+shift+enter'}
        ]
      });

      // Simulated restart: a fresh store over the same backing prefs.
      final restarted = KeymapStore(storage);
      await restarted.load();
      expect(restarted.rules, [
        {'command': 'composer.send', 'keys': 'mod+shift+enter'}
      ]);
    });

    test('setOverride replaces the previous override of the same command',
        () async {
      final store = KeymapStore(storage);
      await store.load();
      await store.setOverride('composer.send', 'mod+enter');
      await store.setOverride('composer.send', 'mod+shift+enter');
      expect(store.rules, hasLength(1));
      expect(store.byCommand, {'composer.send': 'mod+shift+enter'});
    });

    test('resetCommand reverts one command; restoreDefaults clears all',
        () async {
      final store = KeymapStore(storage);
      await store.load();
      await store.setOverride('composer.send', 'mod+shift+enter');
      await store.setOverride('palette.open', 'mod+p');

      await store.resetCommand('composer.send');
      expect(store.byCommand, {'palette.open': 'mod+p'});
      expect(payloadOf(prefs, StoreKeys.keybindings), {
        'rules': [
          {'command': 'palette.open', 'keys': 'mod+p'}
        ]
      });

      await store.restoreDefaults();
      expect(store.rules, isEmpty);
      expect(payloadOf(prefs, StoreKeys.keybindings), {'rules': []});
    });

    test('applyAction maps the three client-owned keybind names (§3)', () async {
      final store = KeymapStore(storage);
      await store.load();

      await store.applyAction(kKeybindSaveAction, {
        'command': 'composer.send',
        kKeyCaptureFieldId: 'mod+shift+enter',
      });
      expect(store.byCommand, {'composer.send': 'mod+shift+enter'});

      await store.applyAction(kKeybindSaveAction, {
        'command': 'composer.newline',
        'keys': 'ctrl+enter',
      });
      expect(store.byCommand['composer.newline'], 'ctrl+enter');

      await store.applyAction(kKeybindResetAction, {'command': 'composer.send'});
      expect(store.byCommand.containsKey('composer.send'), isFalse);

      await store.applyAction(kKeybindRestoreAction, const {});
      expect(store.rules, isEmpty);

      // Unknown names and empty payloads are no-ops, never throws.
      await store.applyAction('unknown-action', const {});
      await store.applyAction(kKeybindSaveAction, const {});
      expect(store.rules, isEmpty);
    });

    test('headerJson advertises the store shape for X-Jhin-Keybindings', () async {
      final store = KeymapStore(storage);
      await store.load();
      expect(store.headerJson, '{"rules":[]}');
      await store.setOverride('composer.send', 'mod+shift+enter');
      expect(
        jsonDecode(store.headerJson),
        {
          'rules': [
            {'command': 'composer.send', 'keys': 'mod+shift+enter'}
          ]
        },
      );
    });
  });

  group('corruption safety (T70 evidence)', () {
    test('a corrupted keybindings blob falls back to server defaults and '
        'quarantines the raw bytes (evidence)', () async {
      const corrupt = '{"rules": [this is not json';
      await prefs.write(StoreKeys.keybindings, corrupt);
      print("corrupt blob: '$corrupt' (${corrupt.length} bytes)");

      final store = KeymapStore(storage);
      await store.load();
      // The app runs on server defaults: zero override rules, no throw.
      expect(store.rules, isEmpty);
      expect(store.headerJson, '{"rules":[]}');
      print('load -> 0 override rules (server defaults active)');

      // The raw bytes are preserved twice: the original key is untouched and
      // a raw copy sits under migration.quarantine:keybindings:<schema>.
      expect(prefs.values[StoreKeys.keybindings], corrupt);
      final copyKey = StoreKeys.quarantineCopy(StoreKeys.keybindings, 1);
      expect(prefs.values[copyKey], corrupt);
      print('quarantine copy $copyKey == raw '
          '(${corrupt.length} bytes preserved)');

      final quarantine = payloadOf(prefs, StoreKeys.quarantine);
      expect(quarantine, contains(StoreKeys.keybindings));
      print('quarantine list contains ${StoreKeys.keybindings}: $quarantine');
      print('original key untouched: '
          '${prefs.values[StoreKeys.keybindings] == corrupt}');
    });

    test('an enveloped blob with a wrong data shape is quarantined the same '
        'way', () async {
      final raw = jsonEncode({
        'schema': 3,
        'app': '0.1.0',
        'writtenAt': '2026-10-04T00:00:00Z',
        'data': {'oops': true},
      });
      await prefs.write(StoreKeys.keybindings, raw);

      final store = KeymapStore(storage);
      await store.load();
      expect(store.rules, isEmpty);
      expect(prefs.values[StoreKeys.keybindings], raw);
      expect(prefs.values[StoreKeys.quarantineCopy(StoreKeys.keybindings, 3)],
          raw);
      expect(payloadOf(prefs, StoreKeys.quarantine),
          contains(StoreKeys.keybindings));
    });

    test('a malformed rules entry is dropped; the well-formed ones survive',
        () async {
      await storage.writeEnvelope(StoreKeys.keybindings, {
        'rules': [
          {'command': 'composer.send', 'keys': 'mod+shift+enter'},
          {'command': 'no-keys'},
          'garbage',
          {'command': 'palette.open', 'keys': 'mod+p'},
        ],
      });
      final store = KeymapStore(storage);
      await store.load();
      expect(store.byCommand, {
        'composer.send': 'mod+shift+enter',
        'palette.open': 'mod+p',
      });
      expect(prefs.values[StoreKeys.quarantineCopy(StoreKeys.keybindings, 3)],
          isNull);
    });

    test('a second load keeps the first quarantine copy (never overwritten)',
        () async {
      const corrupt = 'not-json{{';
      await prefs.write(StoreKeys.keybindings, corrupt);
      await KeymapStore(storage).load();
      // A later write followed by another corrupt blob must not lose the
      // first capture.
      final copyKey = StoreKeys.quarantineCopy(StoreKeys.keybindings, 1);
      expect(prefs.values[copyKey], corrupt);
      await prefs.write(StoreKeys.keybindings, 'other-garbage');
      await KeymapStore(storage).load();
      expect(prefs.values[copyKey], corrupt);
    });
  });
}
