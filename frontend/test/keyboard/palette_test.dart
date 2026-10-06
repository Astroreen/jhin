// ignore_for_file: avoid_print — the T69 QA script tees these transcripts.
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

/// T69 command palette: open/close, the search policy (local-only below two
/// characters, one debounced search POST from two), arrow navigation and
/// Enter dispatch for local commands and server entries.
///
/// Every test drives real hardware chords through the keymap fallbacks into
/// the client-owned overlay hosted by [SduiHost], and counts the search
/// posts through [ScriptedTransport].

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

Map<String, dynamic> chatNode() => {
      'type': 'screen',
      'title': 'Chat',
      'body': {
        'type': 'container',
        'children': [
          {'type': 'text', 'text': 'chat-s1-marker'},
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

  ScriptedTransport transportWith({
    Map<String, dynamic> Function(String path, Object? body)? onPost,
  }) {
    final transport = ScriptedTransport();
    transport.routes['/_jhin/bootstrap'] = sduiPayload(
      entry: 'home',
      screens: {
        'home': homeNode(),
        'chat:s1': chatNode(),
      },
    );
    transport.onPost = onPost ??
        (path, body) => {
              'results': [
                {
                  'id': 'session:s1',
                  'title': 'Fix the widget bug',
                  'kind': 'session',
                  'action': {
                    'op': 'navigate',
                    'screen': 'chat:s1',
                  },
                },
                {
                  'id': 's1#2',
                  'title': 'the widget is fixed',
                  'kind': 'message_end',
                  'action': {
                    'op': 'navigate',
                    'screen': 'chat:s1',
                  },
                },
              ],
            };
    return transport;
  }

  Future<(WhenContext, CommandRegistry)> pumpHost(
    WidgetTester tester,
    ScriptedTransport transport, {
    CommandRegistry? registry,
  }) async {
    final when = WhenContext();
    final commands = registry ?? CommandRegistry();
    final runtime = SduiRuntime(transport: transport);
    await tester.pumpWidget(MaterialApp(
      home: SduiHost(
        key: ValueKey(profile.id),
        profile: profile,
        storage: storage,
        transport: transport,
        renderer: runtime,
        commandRegistry: commands,
        whenContext: when,
        runDirectives: runtime.runDirectives,
      ),
    ));
    await tester.pumpAndSettle();
    return (when, commands);
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

  List<ScriptedCall> searchPosts(ScriptedTransport transport) =>
      transport.calls
          .where((call) =>
              call.method == 'POST' && call.path == '/ui/action/search')
          .toList();

  Finder palette() => find.byKey(const Key('command-palette'));

  Finder entryTile(String id) => find.byKey(Key('palette-entry-$id'));

  group('command palette', () {
    testWidgets(
        'T69 evidence/palette: mod+k opens the overlay, Escape closes it, '
        'paletteOpen tracks the state', (tester) async {
      final transport = transportWith();
      final (whenCtx, _) = await pumpHost(tester, transport);

      expect(whenCtx.paletteOpen, isFalse);
      await press(tester, LogicalKeyboardKey.keyK,
          modifiers: [LogicalKeyboardKey.controlLeft]);

      expect(palette(), findsOneWidget);
      expect(whenCtx.paletteOpen, isTrue);
      print('evidence/palette: opened=true paletteOpen=${whenCtx.paletteOpen}');

      await press(tester, LogicalKeyboardKey.escape);

      expect(palette(), findsNothing);
      expect(whenCtx.paletteOpen, isFalse);
      print('evidence/palette: closed=true paletteOpen=${whenCtx.paletteOpen}');
    });

    testWidgets(
        'T69 evidence/palette: a 1-char query lists only local commands and '
        'never searches', (tester) async {
      final transport = transportWith();
      final (_, commands) = await pumpHost(tester, transport);

      await press(tester, LogicalKeyboardKey.keyK,
          modifiers: [LogicalKeyboardKey.controlLeft]);
      await tester.enterText(find.byKey(const Key('palette-input')), 's');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      final posts = searchPosts(transport);
      final expected = commands.ids
          .where((id) => id.toLowerCase().contains('s'))
          .toList();
      expect(posts, isEmpty);
      expect(expected, isNotEmpty);
      // The T103 picker commands grew the local set past the palette's
      // 420px list window — the builder list lazily builds, so the list is
      // dragged until every entry has been built and asserted.
      final list = find.byKey(const Key('palette-list'));
      var missed = List<String>.from(expected);
      var drags = 0;
      while (missed.isNotEmpty && drags <= expected.length) {
        for (final id in List<String>.from(missed)) {
          if (entryTile(id).evaluate().isNotEmpty) {
            expect(entryTile(id), findsOneWidget);
            missed.remove(id);
          }
        }
        if (missed.isEmpty) break;
        await tester.drag(list, const Offset(0, -120));
        await tester.pump();
        drags++;
      }
      expect(missed, isEmpty,
          reason: 'every matching local command must be listed');
      print('evidence/palette: query=\'s\' localOnly=true '
          'entries=${expected.length} searchPosts=${posts.length}');
    });

    testWidgets(
        'T69 evidence/palette: a 3-char query fires exactly one search POST '
        'and renders the results', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);

      await press(tester, LogicalKeyboardKey.keyK,
          modifiers: [LogicalKeyboardKey.controlLeft]);
      await tester.enterText(find.byKey(const Key('palette-input')), 'fix');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      final posts = searchPosts(transport);
      expect(posts, hasLength(1));
      expect(posts.single.body, {'query': 'fix'});
      expect(find.text('Fix the widget bug'), findsOneWidget);
      expect(find.text('the widget is fixed'), findsOneWidget);
      print('evidence/palette: query=\'fix\' searchPosts=${posts.length} '
          'body={query: fix} results=2');
    });

    testWidgets(
        'T69 evidence/palette: arrow navigation clamps and Enter dispatches '
        'a local command exactly once and closes', (tester) async {
      final transport = transportWith();
      final registry = CommandRegistry();
      var settled = 0;
      registry.register('thread.settle', handler: () {
        settled++;
        return true;
      });
      await pumpHost(tester, transport, registry: registry);

      await press(tester, LogicalKeyboardKey.keyK,
          modifiers: [LogicalKeyboardKey.controlLeft]);
      final ids = registry.ids;

      for (var i = 0; i < 3; i++) {
        await press(tester, LogicalKeyboardKey.arrowDown);
      }
      final fourth = tester
          .widget<ListTile>(entryTile(ids[3]))
          .selected;
      expect(fourth, isTrue);
      print('evidence/palette: arrowDown x3 -> index=3 selected=${ids[3]}');

      for (var i = 0; i < 10; i++) {
        await press(tester, LogicalKeyboardKey.arrowUp);
      }
      final first = tester.widget<ListTile>(entryTile(ids[0])).selected;
      expect(first, isTrue);
      print('evidence/palette: arrowUp x10 -> index=0 clamped=true');

      await tester.enterText(
          find.byKey(const Key('palette-input')), 'settle');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      await press(tester, LogicalKeyboardKey.enter);

      expect(settled, 1);
      expect(palette(), findsNothing);
      print('evidence/palette: enter local dispatches=$settled closed=true');
    });

    testWidgets(
        'T69 evidence/palette: Enter on a server entry dispatches its action '
        'and navigates', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);

      await press(tester, LogicalKeyboardKey.keyK,
          modifiers: [LogicalKeyboardKey.controlLeft]);
      await tester.enterText(find.byKey(const Key('palette-input')), 'fix');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();

      expect(find.text('home-marker'), findsOneWidget);
      await press(tester, LogicalKeyboardKey.enter);

      expect(palette(), findsNothing);
      expect(find.text('chat-s1-marker'), findsOneWidget);
      print('evidence/palette: enter server -> navigated=chat:s1 '
          'closed=true');
    });
  });
}