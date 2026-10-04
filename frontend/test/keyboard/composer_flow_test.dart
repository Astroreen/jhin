// ignore_for_file: avoid_print — the T68 QA script tees these transcripts.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/sdui_host.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/keyboard/composer_commands.dart';
import 'package:jhin/sdui/sdui_runtime.dart';

import '../sdui_fakes.dart';

/// T68 composer keyboard flow: `send` / `sendAndNew` / `newline` / `recall`.
///
/// Every test drives real hardware chords through the keymap (the client
/// fallback chords — the payload carries no server keymap) into a focused
/// composer (`textarea` with the reserved id `messageInput`) hosted by the
/// real SDUI runtime, and counts the action posts through [ScriptedTransport].

Map<String, dynamic> chatNode() => {
      'type': 'screen',
      'title': 'Chat',
      'body': {
        'type': 'container',
        'direction': 'column',
        'children': [
          {
            'type': 'textarea',
            'id': kComposerFieldId,
            'label': 'Message',
            'required': true,
            'errorText': 'Write a message first',
            'minLines': 1,
            'maxLines': 8,
            'autofocus': true,
          },
          {
            'type': 'button',
            'label': 'Send',
            'action': {
              'path': '/ui/action/send',
              'method': 'POST',
              'name': 'send',
              'payload': {'sessionId': 's1'},
              'include': [kComposerFieldId],
            },
          },
          {'type': 'input', 'id': 'workdir', 'value': '/tmp/work'},
          {'type': 'input', 'id': 'model', 'value': 'echo'},
        ],
      },
    };

Map<String, dynamic> newChatNode() => {
      'type': 'screen',
      'title': 'New',
      'body': {
        'type': 'container',
        'children': [
          {'type': 'text', 'text': 'new-chat-marker'},
          {
            'type': 'textarea',
            'id': kComposerFieldId,
            'label': 'Message',
            'required': true,
            'errorText': 'Write a message first',
            'minLines': 1,
            'maxLines': 8,
          },
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
      entry: 'chat:s1',
      screens: {
        'chat:s1': chatNode(),
        'chat:new-1': newChatNode(),
      },
    );
    transport.onPost = onPost ??
        (path, body) {
          // Mirrors `jhin.ui`'s CreateSessionAction: the response carries the
          // navigation to the fresh chat.
          if (path == '/ui/action/create-session') {
            return {
              'client': [
                {'op': 'navigate', 'screen': 'chat:new-1'},
              ],
            };
          }
          return {'client': <dynamic>[]};
        };
    return transport;
  }

  Future<void> pumpHost(
    WidgetTester tester,
    ScriptedTransport transport, {
    ServerProfile? forProfile,
  }) async {
    final bound = forProfile ?? profile;
    await tester.pumpWidget(MaterialApp(
      home: SduiHost(
        // Keyed by profile exactly as the app shell keys it (main.dart) —
        // a profile switch always boots a fresh host.
        key: ValueKey(bound.id),
        profile: bound,
        storage: storage,
        transport: transport,
        renderer: SduiRuntime(transport: transport),
      ),
    ));
    await tester.pumpAndSettle();
  }

  Finder composer() => find.byType(TextField).first;

  TextEditingController composerController(WidgetTester tester) =>
      tester.widget<EditableText>(find.byType(EditableText).first).controller;

  List<ScriptedCall> posts(ScriptedTransport transport, String name) =>
      transport.calls
          .where((call) =>
              call.method == 'POST' && call.path == '/ui/action/$name')
          .toList();

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

  Future<void> setDraft(
    WidgetTester tester, {
    required String text,
    required int caret,
  }) async {
    await tester.showKeyboard(composer());
    tester.testTextInput.updateEditingValue(TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: caret),
    ));
    await tester.pump();
  }

  group('composer keyboard flow', () {
    testWidgets(
        'T68 evidence/send: Ctrl+Enter dispatches the send action exactly once',
        (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();
      await tester.enterText(composer(), 'hello');
      await tester.pump();

      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft]);

      final sent = posts(transport, 'send');
      print('evidence/send: send posts=${sent.length} path=/ui/action/send');
      for (final call in sent) {
        print('evidence/send: body=${call.body}');
      }
      print(
          'evidence/send: draft after send=${composerController(tester).text.isEmpty ? "cleared" : composerController(tester).text}');

      expect(sent, hasLength(1));
      final body = sent.single.body as Map;
      expect(body['action'], 'send');
      expect(body['payload'], {'sessionId': 's1', 'messageInput': 'hello'});
      expect(composerController(tester).text, isEmpty);
    });

    testWidgets(
        'T68 evidence/send: Shift+Enter inserts a newline and never submits',
        (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();
      await tester.enterText(composer(), 'hello');
      await tester.pump();

      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.shiftLeft]);

      final postsAfter = transport.calls.where((c) => c.method == 'POST');
      final text = composerController(tester).text;
      print("evidence/send: newline inserted: 'hello' -> "
          "'${text.replaceAll('\n', r'\n')}'");
      print('evidence/send: posts after shift+enter=${postsAfter.length}');

      expect(text, 'hello\n');
      expect(postsAfter, isEmpty);
    });

    testWidgets(
        'T68 evidence/send-and-new: Ctrl+Alt+Enter sends, creates a session '
        'and navigates', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();
      await tester.enterText(composer(), 'hello from the composer');
      await tester.pump();

      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [
            LogicalKeyboardKey.controlLeft,
            LogicalKeyboardKey.altLeft,
          ]);

      final sent = posts(transport, 'send');
      final created = posts(transport, 'create-session');
      print('evidence/send-and-new: send posts=${sent.length} '
          'create-session posts=${created.length}');
      if (created.isNotEmpty) {
        print('evidence/send-and-new: create-session body=${created.single.body}');
      }
      print('evidence/send-and-new: navigated=${find.text('new-chat-marker').evaluate().length == 1}');
      print(
          'evidence/send-and-new: new session composer empty=${composerController(tester).text.isEmpty}');

      expect(sent, hasLength(1));
      expect(created, hasLength(1));
      expect(find.text('new-chat-marker'), findsOneWidget);
      final payload = (created.single.body as Map)['payload'] as Map;
      expect(payload['title'], 'hello from the composer');
      expect(payload['workdir'], '/tmp/work');
      expect(payload['model'], 'echo');
      expect(composerController(tester).text, isEmpty);
    });

    testWidgets(
        'T68 evidence/recall: ArrowUp and ArrowDown walk the sent-prompt '
        'history', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();

      await tester.enterText(composer(), 'first prompt');
      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft]);
      await tester.enterText(composer(), 'second prompt');
      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft]);
      print('evidence/recall: sent two prompts (history=2)');

      await press(tester, LogicalKeyboardKey.arrowUp);
      final one = composerController(tester).text;
      print("evidence/recall: ArrowUp -> '$one'");

      await press(tester, LogicalKeyboardKey.arrowUp);
      final two = composerController(tester).text;
      print("evidence/recall: ArrowUp -> '$two'");

      await press(tester, LogicalKeyboardKey.arrowDown);
      final three = composerController(tester).text;
      print("evidence/recall: ArrowDown -> '$three'");

      await press(tester, LogicalKeyboardKey.arrowDown);
      final four = composerController(tester).text;
      print('evidence/recall: ArrowDown -> '
          '${four.isEmpty ? "(cleared)" : four}');

      expect(one, 'second prompt');
      expect(two, 'first prompt');
      expect(three, 'second prompt');
      expect(four, isEmpty);
      expect(posts(transport, 'send'), hasLength(2));
    });

    testWidgets(
        'T68 evidence/recall: a non-empty composer declines and the caret '
        'still moves', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();
      await setDraft(tester, text: 'one\ntwo', caret: 7);

      final before = composerController(tester).selection.baseOffset;
      await press(tester, LogicalKeyboardKey.arrowUp);
      final after = composerController(tester).selection.baseOffset;
      final text = composerController(tester).text;
      print('evidence/recall: typed draft kept='
          "'${text.replaceAll('\n', r'\n')}' (declined), caret $before -> $after");

      expect(text, 'one\ntwo'); // no history overwrite
      expect(after, isNot(before)); // the arrow key was not swallowed
      expect(posts(transport, 'send'), isEmpty);
    });

    testWidgets(
        'T68 evidence/recall: history is per-profile (profile A invisible in '
        'profile B)', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();
      await tester.enterText(composer(), 'profile a prompt');
      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft]);

      final profileB =
          await storage.addProfile(label: 'other', url: 'https://other');
      await pumpHost(tester, transport, forProfile: profileB);
      await tester.tap(composer());
      await tester.pump();

      await press(tester, LogicalKeyboardKey.arrowUp);
      final text = composerController(tester).text;
      print('evidence/recall: profile B recall -> '
          '${text.isEmpty ? "(empty: profile A history invisible)" : text}');

      expect(text, isEmpty);
    });

    testWidgets(
        'T68 evidence/failure: an empty composer dispatches nothing and shows '
        'errorText', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();

      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [LogicalKeyboardKey.controlLeft]);

      final postsAfter = transport.calls.where((c) => c.method == 'POST');
      final errorVisible = find.text('Write a message first').evaluate().length;
      print('evidence/failure: empty composer posts=${postsAfter.length} '
          "errorText='Write a message first' visible=$errorVisible");

      expect(postsAfter, isEmpty);
      expect(find.text('Write a message first'), findsOneWidget);
    });

    testWidgets(
        'T68 evidence/failure: a create-session 4xx keeps the draft and shows '
        'a toast', (tester) async {
      final transport = transportWith(onPost: (path, body) {
        if (path == '/ui/action/create-session') {
          throw Exception('HTTP 400 invalid_request');
        }
        return {'client': <dynamic>[]};
      });
      await pumpHost(tester, transport);
      await tester.tap(composer());
      await tester.pump();
      await tester.enterText(composer(), 'hello');
      await tester.pump();

      await press(tester, LogicalKeyboardKey.enter,
          modifiers: [
            LogicalKeyboardKey.controlLeft,
            LogicalKeyboardKey.altLeft,
          ]);

      final draft = composerController(tester).text;
      final toastVisible =
          find.text(ComposerCommands.createFailed).evaluate().length;
      print('evidence/failure: create-session 400 draft kept=\'$draft\' '
          "toast='$toastVisible visible'");

      expect(posts(transport, 'send'), hasLength(1));
      expect(posts(transport, 'create-session'), hasLength(1));
      expect(draft, 'hello'); // never lose user text
      expect(find.text(ComposerCommands.createFailed), findsOneWidget);
      // Burn the toast timer so the test ends with no pending timers.
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
