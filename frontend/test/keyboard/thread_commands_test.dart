// ignore_for_file: avoid_print — the T69 QA script tees these transcripts.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/keyboard/command_registry.dart';
import 'package:jhin/sdui/keyboard/palette.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';
import 'package:jhin/store/versioned_store.dart';

/// T69 thread commands: `thread.jump1..9` over the server's session list,
/// `thread.undo` through `POST /ui/action/undo` (nothing-to-undo, 404-safe
/// and success directives) and `appearance.cycle` / `theme.pick` persistence.

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;

  setUp(() async {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
  });

  /// Builds the T69 command set over recording fakes.
  (PaletteCommands, List<Map<String, dynamic>>, int Function()) build({
    PalettePost? post,
    PaletteGetList? getList,
    List<String> accentPresets = const [],
  }) {
    final registry = CommandRegistry();
    final directives = <Map<String, dynamic>>[];
    var appearanceChanges = 0;
    final commands = PaletteCommands(
      registry: registry,
      whenContext: WhenContext(),
      post: post ?? (path, body) async => <String, dynamic>{},
      getList: getList ?? (path) async => <dynamic>[],
      storage: storage,
      runDirectives: (ops) async {
        for (final op in ops) {
          directives.add(Map<String, dynamic>.from(op as Map));
        }
      },
      onAppearanceChanged: () => appearanceChanges++,
      accentPresets: accentPresets,
    );
    return (commands, directives, () => appearanceChanges);
  }

  Future<void> settle() => pumpEventQueue();

  group('thread.jump1..9', () {
    test('T69 evidence/jump: jump3 navigates to the third session of the '
        'list order', () async {
      final (commands, directives, _) = build(
        getList: (path) async => [
          {'id': 's1'},
          {'id': 's2'},
          {'id': 's3'},
          {'id': 's4'},
          {'id': 's5'},
        ],
      );

      expect(commands.controller.registry.dispatch('thread.jump3'), isTrue);
      await settle();

      expect(directives, [
        {'op': 'navigate', 'screen': 'chat:s3'},
      ]);
      print('evidence/jump: jump3 -> navigated=chat:s3 '
          '(source=/sessions order, 5 sessions)');
    });

    test('jump beyond the list toasts and never navigates', () async {
      final (commands, directives, _) = build(
        getList: (path) async => [
          {'id': 's1'},
          {'id': 's2'},
        ],
      );

      commands.controller.registry.dispatch('thread.jump6');
      await settle();

      expect(directives, hasLength(1));
      expect(directives.single['op'], 'toast');
      expect(directives.single['text'], 'No session at position 6.');
    });

    test('a failing session list degrades to a toast, never a crash',
        () async {
      final (commands, directives, _) = build(
        getList: (path) async => throw Exception('offline'),
      );

      commands.controller.registry.dispatch('thread.jump1');
      await settle();

      expect(directives.single['op'], 'toast');
    });
  });

  group('thread.undo', () {
    test(
        'T69 evidence/undo-window: a nothing-to-undo answer runs its toast '
        '(no-window no-op)', () async {
      final (commands, directives, _) = build(
        post: (path, body) async {
          expect(path, '/ui/action/undo');
          expect(body, {
            'action': 'undo',
            'payload': <String, dynamic>{},
          });
          return {
            'client': [
              {
                'op': 'toast',
                'text': 'Nothing to undo',
                'style': 'error',
              },
            ],
          };
        },
      );

      expect(commands.controller.registry.dispatch('thread.undo'), isTrue);
      await settle();

      expect(directives, [
        {'op': 'toast', 'text': 'Nothing to undo', 'style': 'error'},
      ]);
      print("evidence/undo-window: nothing-to-undo "
          "toast='${directives.single['text']}' "
          "style=${directives.single['style']}");
    });

    test('T69 evidence/undo-window: a 404 (undo endpoint absent) toasts and '
        'never crashes', () async {
      final (commands, directives, _) = build(
        post: (path, body) async => throw Exception('404 unknown_action'),
      );

      commands.controller.registry.dispatch('thread.undo');
      await settle();

      expect(directives, [
        {'op': 'toast', 'text': 'Nothing to undo', 'style': 'error'},
      ]);
      print("evidence/undo-window: 404 "
          "toast='${directives.single['text']}' crashed=false");
    });

    test('T69 evidence/undo-window: success directives run', () async {
      final (commands, directives, _) = build(
        post: (path, body) async => {
              'client': [
                {'op': 'toast', 'text': 'Undone'},
                {'op': 'refresh'},
              ],
            },
      );

      commands.controller.registry.dispatch('thread.undo');
      await settle();

      expect(directives, [
        {'op': 'toast', 'text': 'Undone'},
        {'op': 'refresh'},
      ]);
      print('evidence/undo-window: success '
          'directives=${directives.map((op) => op['op']).join(',')}');
    });
  });

  group('appearance.cycle / theme.pick', () {
    test('appearance.cycle persists across a simulated restart and flips the '
        'theme mode', () async {
      await storage.writeEnvelope(StoreKeys.appearance, {
        'themeMode': 'system',
        'textSize': 14,
        'density': 'comfortable',
        'panelMotionMs': 0,
      });
      final (commands, _, changes) = build();

      commands.controller.registry.dispatch('appearance.cycle');
      await settle();

      final afterFirst = await AppearancePrefs.read(storage);
      expect(afterFirst['themeMode'], 'light');
      expect(changes(), 1);
      expect(JhinTheme.from(appearance: afterFirst['themeMode']).themeMode,
          ThemeMode.light);

      // Simulated restart: a fresh AppStorage over the same preferences.
      final restarted = AppStorage(prefs: prefs, secrets: secrets);
      final reread = await AppearancePrefs.read(restarted);
      expect(reread['themeMode'], 'light');
      expect(reread['textSize'], 14);

      commands.controller.registry.dispatch('appearance.cycle');
      await settle();
      expect((await AppearancePrefs.read(storage))['themeMode'], 'dark');
    });

    test('theme.pick cycles the accent through the server presets and '
        'persists it', () async {
      final (commands, _, changes) = build(
        accentPresets: ['#111111', '#222222', '#333333'],
      );

      commands.controller.registry.dispatch('theme.pick');
      await settle();
      expect((await AppearancePrefs.read(storage))['accent'], '#222222');

      commands.controller.registry.dispatch('theme.pick');
      await settle();
      expect((await AppearancePrefs.read(storage))['accent'], '#333333');

      commands.controller.registry.dispatch('theme.pick');
      await settle();
      expect((await AppearancePrefs.read(storage))['accent'], '#111111');
      expect(changes(), 3);
    });

    test('theme.pick with no server presets is a no-op', () async {
      final (commands, _, changes) = build();

      commands.controller.registry.dispatch('theme.pick');
      await settle();

      expect(await AppearancePrefs.read(storage), isEmpty);
      expect(changes(), 0);
    });
  });
}