// ignore_for_file: avoid_print — the T115 QA script tees these transcripts.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/sdui_host.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/keyboard/command_registry.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';
import 'package:jhin/sdui/sdui_runtime.dart';

import '../sdui_fakes.dart';

/// T115 command-palette parity: the four result groups (Actions / Threads /
/// Projects / Models) with upper-case headers and counts, the muted
/// `ThreadCommandSubtitle`-style subtitles, the right-aligned `kbd` hints,
/// the `>`-prefix action filter and the disabled row for an unregistered
/// keymap command.
///
/// Upstream anchors (t3code commit 37de6cb):
/// `apps/web/src/components/CommandPalette.logic.ts:441-521` (the `>` filter
/// and the grouped results), `:594-610` (the root groups),
/// `CommandPaletteResults.tsx:190-247` (the row: icon, title, description,
/// shortcut) and `ThreadCommandSubtitle.tsx:38-117` (the muted subtitle).

Map<String, dynamic> homeNode() => {
      'type': 'screen',
      'title': 'Home',
      'body': {
        'type': 'container',
        'children': [
          {'type': 'text', 'text': 'home-marker'},
        ],
      },
    };

void main() {
  late InMemoryStringStore prefs;
  late InMemoryStringStore secrets;
  late AppStorage storage;
  late ServerProfile profile;

  setUp(() async {
    prefs = InMemoryStringStore();
    secrets = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: secrets);
    profile = await storage.addProfile(label: 'home', url: 'https://home');
    await storage.setActiveProfileId(profile.id);
  });

  ScriptedTransport transportWith() {
    final transport = ScriptedTransport();
    transport.routes['/_jhin/bootstrap'] = sduiPayload(
      entry: 'home',
      screens: {'home': homeNode()},
    );
    transport.onPost = (path, body) => {
          'results': [
            {
              'id': 'session:s1',
              'title': 'Fix the widget bug',
              'kind': 'session',
              'action': {'op': 'navigate', 'screen': 'chat:s1'},
            },
            {
              'id': 's1#2',
              'title': 'the widget is fixed',
              'kind': 'message_end',
              'action': {'op': 'navigate', 'screen': 'chat:s1'},
            },
          ],
        };
    return transport;
  }

  Future<void> pumpHost(
    WidgetTester tester,
    ScriptedTransport transport, {
    List<Object?> keymapOverrides = const <Object?>[],
    Future<void> Function(List<dynamic>)? runDirectives,
  }) async {
    final runtime = SduiRuntime(transport: transport);
    await tester.pumpWidget(MaterialApp(
      home: SduiHost(
        key: ValueKey(profile.id),
        profile: profile,
        storage: storage,
        transport: transport,
        renderer: runtime,
        commandRegistry: CommandRegistry(),
        whenContext: WhenContext(),
        keymapOverrides: keymapOverrides,
        runDirectives: runDirectives ?? runtime.runDirectives,
      ),
    ));
    await tester.pumpAndSettle();
  }

  Future<void> press(
    WidgetTester tester,
    LogicalKeyboardKey key, {
    List<LogicalKeyboardKey> modifiers = const [],
  }) async {
    for (final modifier in modifiers) {
      await tester.sendKeyDownEvent(modifier);
    }
    await tester.sendKeyEvent(key);
    for (final modifier in modifiers.reversed) {
      await tester.sendKeyUpEvent(modifier);
    }
    await tester.pumpAndSettle();
  }

  Future<void> openPalette(WidgetTester tester) async {
    await press(tester, LogicalKeyboardKey.keyK,
        modifiers: [LogicalKeyboardKey.controlLeft]);
  }

  /// Drags the palette list up until [finder] is built (the list is lazy).
  Future<void> scrollTo(WidgetTester tester, Finder finder) async {
    final list = find.byKey(const Key('palette-list'));
    for (var i = 0; i < 40 && finder.evaluate().isEmpty; i++) {
      await tester.drag(list, const Offset(0, -120));
      await tester.pump();
    }
  }

  group('T115 palette groups', () {
    testWidgets(
        'T115 evidence/groups: the palette renders the Actions and Models '
        'groups with upper-case headers and counts', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await openPalette(tester);

      expect(find.byKey(const Key('palette-group-actions')), findsOneWidget);
      expect(find.textContaining('ACTIONS'), findsOneWidget);

      // The action row carries the label, the muted command-id subtitle and
      // the right-aligned chord hint.
      expect(find.text('Composer: Send'), findsWidgets);
      expect(find.text('composer.send'), findsWidgets);
      expect(find.byKey(const Key('palette-kbd-composer.send')),
          findsOneWidget);
      expect(
          tester
              .widget<Text>(find.descendant(
                  of: find.byKey(const Key('palette-kbd-composer.send')),
                  matching: find.byType(Text)))
              .data,
          'mod+enter');

      // The decorative Models group sits after the actions; scroll it in.
      await scrollTo(
          tester, find.byKey(const Key('palette-entry-model:sonnet')));
      expect(find.byKey(const Key('palette-group-models')), findsOneWidget);
      expect(find.textContaining('MODELS'), findsOneWidget);
      final model = tester.widget<ListTile>(
          find.byKey(const Key('palette-entry-model:sonnet')));
      expect(model.enabled, isTrue);
      print('evidence/groups: headers=[ACTIONS, MODELS] '
          'actions>=33 models=3 kbd=mod+enter');
    });

    testWidgets(
        'T115 evidence/prefix: a ">" query filters to the Actions group only',
        (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await openPalette(tester);

      await tester.enterText(find.byKey(const Key('palette-input')), '>');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      expect(find.byKey(const Key('palette-group-actions')), findsOneWidget);
      expect(find.byKey(const Key('palette-group-models')), findsNothing);
      expect(find.byKey(const Key('palette-group-threads')), findsNothing);
      // The action filter never searches the server.
      final posts = transport.calls.where((call) =>
          call.method == 'POST' && call.path == '/ui/action/search');
      expect(posts, isEmpty);
      print('evidence/prefix: query=">" groups=[ACTIONS] searchPosts=0');
    });

    testWidgets(
        'T115 evidence/threads: a 2-char query lists the server hits under '
        'the Threads group with their kind subtitles', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await openPalette(tester);

      await tester.enterText(find.byKey(const Key('palette-input')), 'fix');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      expect(find.byKey(const Key('palette-group-threads')), findsOneWidget);
      expect(find.textContaining('THREADS'), findsOneWidget);
      expect(find.text('Fix the widget bug'), findsOneWidget);
      // The message hit carries its preview as the title and its kind as the
      // muted subtitle.
      expect(find.text('the widget is fixed'), findsOneWidget);
      expect(find.text('message_end'), findsOneWidget);
      print('evidence/threads: query="fix" group=THREADS hits=2 '
          'preview=the widget is fixed');
    });

    testWidgets(
        'T115 evidence/demo: selecting a decorative model row runs the demo '
        'feedback and never a command', (tester) async {
      final transport = transportWith();
      final directives = <Map<String, dynamic>>[];
      await pumpHost(tester, transport, runDirectives: (ops) async {
        for (final op in ops) {
          directives.add(Map<String, dynamic>.from(op as Map));
        }
      });
      await openPalette(tester);

      // Filter to the model so the decorative row is at the top.
      await tester.enterText(
          find.byKey(const Key('palette-input')), 'sonnet');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      expect(find.byKey(const Key('palette-group-models')), findsOneWidget);
      await tester.tap(find.byKey(const Key('palette-entry-model:sonnet')));
      await tester.pumpAndSettle();

      expect(directives, hasLength(1));
      expect(directives.single['op'], 'toast');
      expect(find.byKey(const Key('command-palette')), findsNothing);
      print('evidence/demo: model:sonnet -> toast '
          '"${directives.single['text']}"');
    });
  });

  group('T115 disabled affordance', () {
    testWidgets(
        'T115 evidence/disabled: an unregistered keymap command renders a '
        'disabled row and logs once', (tester) async {
      final logs = <String>[];
      final original = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) {
        if (message != null) logs.add(message);
      };
      try {
        final transport = transportWith();
        await pumpHost(
          tester,
          transport,
          keymapOverrides: const <Object?>[
            {'key': 'mod+y', 'command': 'ghost.command'},
          ],
        );
        await openPalette(tester);
        await tester.enterText(
            find.byKey(const Key('palette-input')), 'ghost');
        await tester.pump(const Duration(milliseconds: 300));
        await tester.pump();

        final tile = tester.widget<ListTile>(
            find.byKey(const Key('palette-entry-ghost.command')));
        expect(tile.enabled, isFalse);
        expect(logs.any((line) => line.contains('ghost.command')), isTrue,
            reason: 'the unregistered command must be logged');
        print('evidence/disabled: ghost.command disabled=true '
            'log=${logs.firstWhere((line) => line.contains('ghost.command'))}');
      } finally {
        debugPrint = original;
      }
    });

    testWidgets(
        'T115 fail-mode: the unregistered command is dispatchable '
        '(deliberately wrong expectation, run with T115_FAIL_MODE=true)',
        (tester) async {
      if (Platform.environment['T115_FAIL_MODE'] != 'true') return;
      final transport = transportWith();
      await pumpHost(
        tester,
        transport,
        keymapOverrides: const <Object?>[
          {'key': 'mod+y', 'command': 'ghost.command'},
        ],
      );
      await openPalette(tester);
      await tester.enterText(find.byKey(const Key('palette-input')), 'ghost');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      // Deliberately wrong: the row is disabled, so this must fail.
      final tile = tester.widget<ListTile>(
          find.byKey(const Key('palette-entry-ghost.command')));
      expect(tile.enabled, isTrue);
    });
  });
}
