// ignore_for_file: avoid_print — the T70 QA script tees these transcripts.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/sdui_host.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/keyboard/command_registry.dart';
import 'package:jhin/sdui/keyboard/composer_commands.dart';
import 'package:jhin/sdui/keyboard/keymap.dart';
import 'package:jhin/sdui/keyboard/palette.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';
import 'package:jhin/sdui/sdui_runtime.dart';

import '../sdui_fakes.dart';
import '../store/fixtures.dart';

/// The server default keymap of `jhin.ui`'s `DefaultKeymap` (the default
/// layer user overrides are merged over).
const List<Object?> serverDefaultsV1 = <Object?>[
  {'key': 'mod+enter', 'command': 'composer.send', 'when': 'composerFocus'},
  {'key': 'shift+enter', 'command': 'composer.newline', 'when': 'composerFocus'},
  {'key': 'ctrl+k', 'command': 'palette.open'},
];

/// The same keymap after an upgrade added one NEW default binding.
const List<Object?> serverDefaultsV2 = <Object?>[
  {'key': 'mod+enter', 'command': 'composer.send', 'when': 'composerFocus'},
  {'key': 'shift+enter', 'command': 'composer.newline', 'when': 'composerFocus'},
  {'key': 'ctrl+k', 'command': 'palette.open'},
  {'key': 'mod+1', 'command': 'thread.jump1'},
];

Keymap effective(List<Object?> serverKeymap, List<Object?> overrides) => Keymap
    .resolve(serverKeymap, overrides, platform: KeyPlatform.linux)
    .withDefaults(ComposerCommands.defaultKeymapRules)
    .withDefaults(PaletteCommands.defaultKeymapRules);

void main() {
  group('persisted keybindings (T70 acceptance 1)', () {
    test('rebind persists across a restart and rebinds the effective keymap '
        '(evidence T70)', () async {
      final storage = memoryStorage();
      final store = KeymapStore(storage);
      await store.load();

      // Rebind composer.send to mod+shift+enter (the settings surface goes
      // through the same client-owned action side effect).
      await store.applyAction(kKeybindSaveAction, {
        'command': 'composer.send',
        kKeyCaptureFieldId: 'mod+shift+enter',
      });
      print('rebind composer.send: mod+enter -> mod+shift+enter');

      // Simulated restart: a fresh store over the same backing prefs.
      final restarted = KeymapStore(storage);
      await restarted.load();
      expect(restarted.byCommand, {'composer.send': 'mod+shift+enter'});
      print('store read-back after restart: ${restarted.rules}');

      // The effective keymap: server defaults + the override (per command).
      final keymap = effective(serverDefaultsV1, restarted.rules);
      final focused = WhenContext()..composerFocus = true;
      final fired = keymap.commandFor(
          KeyChord.parse('mod+shift+enter', platform: KeyPlatform.linux)!,
          focused);
      expect(fired, 'composer.send');
      print('effective: mod+shift+enter -> $fired (fires)');

      final dead = keymap.commandFor(
          KeyChord.parse('mod+enter', platform: KeyPlatform.linux)!, focused);
      expect(dead, isNull);
      print('effective: mod+enter -> none (old chord dead)');
    });

    test('an override survives an upgrade that adds a new default '
        '(evidence T70)', () async {
      final storage = memoryStorage();
      final store = KeymapStore(storage);
      await store.load();
      await store.setOverride('composer.send', 'mod+shift+enter');

      // Upgrade: the server keymap gains a NEW default (thread.jump1). The
      // un-overridden commands pick it up; the override is never dropped.
      final keymap = effective(serverDefaultsV2, store.rules);
      final any = WhenContext()..composerFocus = true;
      print('upgrade: server default added thread.jump1 = mod+1');
      expect(
        keymap.commandFor(
            KeyChord.parse('mod+shift+enter', platform: KeyPlatform.linux)!,
            any),
        'composer.send',
      );
      print('override kept: mod+shift+enter -> composer.send');

      expect(
        keymap.commandFor(
            KeyChord.parse('mod+1', platform: KeyPlatform.linux)!,
            WhenContext()),
        'thread.jump1',
      );
      print('new default active: mod+1 -> thread.jump1');

      expect(
        keymap.commandFor(
            KeyChord.parse('mod+enter', platform: KeyPlatform.linux)!,
            any),
        isNull,
      );
      print('old default dead: mod+enter -> none');
    });

    test('restore defaults clears the overrides and the server chords return',
        () async {
      final storage = memoryStorage();
      final store = KeymapStore(storage);
      await store.load();
      await store.setOverride('composer.send', 'mod+shift+enter');
      await store.restoreDefaults();

      final keymap = effective(serverDefaultsV1, store.rules);
      final focused = WhenContext()..composerFocus = true;
      expect(
        keymap.commandFor(
            KeyChord.parse('mod+enter', platform: KeyPlatform.linux)!, focused),
        'composer.send',
      );
      expect(
        keymap.commandFor(
            KeyChord.parse('mod+shift+enter', platform: KeyPlatform.linux)!,
            focused),
        isNull,
      );
    });
  });

  group('live keymap re-resolve (T70 acceptance 1, widget)', () {
    late InMemoryStringStore prefs;
    late AppStorage storage;

    setUp(() {
      prefs = InMemoryStringStore();
      storage = AppStorage(prefs: prefs, secrets: InMemoryStringStore());
    });

    Future<void> pressChord(WidgetTester tester, LogicalKeyboardKey key,
        List<LogicalKeyboardKey> modifiers) async {
      for (final modifier in modifiers) {
        await tester.sendKeyDownEvent(modifier);
      }
      await tester.sendKeyEvent(key);
      for (final modifier in modifiers.reversed) {
        await tester.sendKeyUpEvent(modifier);
      }
      await tester.pumpAndSettle();
    }

    testWidgets(
        'the rebound chord fires and the old chord dies without a restart',
        (tester) async {
      final store = KeymapStore(storage);
      await store.load();
      await store.setOverride('composer.send', 'mod+shift+enter');

      final transport = ScriptedTransport();
      final payload = sduiPayload(
        entry: 'chat:s1',
        screens: {
          'chat:s1': {
            'type': 'container',
            'children': [
              {
                'type': 'textarea',
                'id': 'messageInput',
                'label': 'Message',
                'minLines': 1,
                'maxLines': 8,
              },
            ],
          },
        },
      );
      // The real server sends the default keymap; the override inherits its
      // `when: composerFocus` gate so the rebound chord still fires in the
      // focused composer.
      payload['keymap'] = serverDefaultsV1;
      transport.routes['/_jhin/bootstrap'] = payload;

      var sent = 0;
      final registry = CommandRegistry();
      registry.register('composer.send', handler: () {
        sent++;
        return true;
      });

      await tester.pumpWidget(MaterialApp(
        home: SduiHost(
          profile: ServerProfile(
              id: 'p1', label: 'home', url: 'https://home', token: null),
          storage: storage,
          transport: transport,
          renderer: SduiRuntime(transport: transport, keymapStore: store),
          commandRegistry: registry,
          keymapStore: store,
        ),
      ));
      await tester.pumpAndSettle();

      // Focus the composer so `when: composerFocus` is on.
      await tester.tap(find.byType(TextField).first);
      await tester.pumpAndSettle();

      // The rebound chord fires...
      await pressChord(tester, LogicalKeyboardKey.enter,
          [LogicalKeyboardKey.controlLeft, LogicalKeyboardKey.shiftLeft]);
      expect(sent, 1);

      // ...and the old chord is dead: the override replaced it and no
      // fallback rule re-binds it.
      await pressChord(
          tester, LogicalKeyboardKey.enter, [LogicalKeyboardKey.controlLeft]);
      expect(sent, 1);
    });
  });
}
