import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/sdui_host.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/keyboard/command_registry.dart';
import 'package:jhin/sdui/keyboard/command_shortcuts.dart';
import 'package:jhin/sdui/keyboard/keymap.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';

import '../test_fakes.dart';

Widget wrap(Widget child) => MaterialApp(home: child);

Future<void> pressChord(
  WidgetTester tester,
  LogicalKeyboardKey key,
  LogicalKeyboardKey modifier,
) async {
  await tester.sendKeyDownEvent(modifier);
  await tester.sendKeyEvent(key);
  await tester.sendKeyUpEvent(modifier);
}

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

  group('CommandShortcuts install', () {
    testWidgets('a hardware chord dispatches the registered handler once '
        '(fake handler spy)', (tester) async {
      final registry = CommandRegistry();
      var sent = 0;
      registry.register('palette.open', handler: () { sent++; return true; });
      final payload = bootstrapPayload(entry: 'home', marker: 'tree-marker');
      payload['keymap'] = [
        {'key': 'ctrl+k', 'command': 'palette.open'},
      ];
      final transport = FakeTransport(bootstrap: payload);

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
        commandRegistry: registry,
      )));
      await tester.pumpAndSettle();

      expect(find.text('tree-marker'), findsOneWidget);

      await pressChord(tester, LogicalKeyboardKey.keyK, LogicalKeyboardKey.controlLeft);
      expect(sent, 1);

      await pressChord(tester, LogicalKeyboardKey.keyK, LogicalKeyboardKey.controlLeft);
      expect(sent, 2);
    });

    testWidgets('a keymap rule with an inactive when does not dispatch',
        (tester) async {
      final registry = CommandRegistry();
      var sent = 0;
      registry.register('composer.send', handler: () { sent++; return true; });
      final payload = bootstrapPayload(entry: 'home', marker: 'tree-marker');
      payload['keymap'] = [
        {
          'key': 'mod+enter',
          'command': 'composer.send',
          'when': 'composerFocus',
        },
      ];
      final transport = FakeTransport(bootstrap: payload);

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
        commandRegistry: registry,
      )));
      await tester.pumpAndSettle();

      await pressChord(tester, LogicalKeyboardKey.enter, LogicalKeyboardKey.controlLeft);
      expect(sent, 0);
    });

    testWidgets('an unknown command in the keymap dispatches nothing and '
        'never throws', (tester) async {
      final registry = CommandRegistry();
      final payload = bootstrapPayload(entry: 'home', marker: 'tree-marker');
      payload['keymap'] = [
        {'key': 'ctrl+k', 'command': 'not.a.command'},
      ];
      final transport = FakeTransport(bootstrap: payload);

      await tester.pumpWidget(wrap(SduiHost(
        profile: profile,
        storage: storage,
        transport: transport,
        commandRegistry: registry,
      )));
      await tester.pumpAndSettle();

      await pressChord(tester, LogicalKeyboardKey.keyK, LogicalKeyboardKey.controlLeft);

      expect(tester.takeException(), isNull);
    });

    testWidgets('typing policy: a context-free chord does not fire while a '
        'text field is focused', (tester) async {
      final registry = CommandRegistry();
      var sent = 0;
      registry.register('palette.open', handler: () { sent++; return true; });
      final keymap = Keymap.parse([
        {'key': 'ctrl+k', 'command': 'palette.open'},
      ]);

      await tester.pumpWidget(wrap(CommandShortcuts(
        registry: registry,
        whenContext: WhenContext(),
        keymap: keymap,
        child: const Scaffold(body: Center(child: TextField())),
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();

      await pressChord(tester, LogicalKeyboardKey.keyK, LogicalKeyboardKey.controlLeft);
      expect(sent, 0, reason: 'typing must not be hijacked');
    });

    testWidgets('typing policy: a when-qualified chord follows its expression '
        'while typing', (tester) async {
      final registry = CommandRegistry();
      var sent = 0;
      registry.register('composer.newline', handler: () { sent++; return true; });
      final keymap = Keymap.parse([
        {
          'key': 'shift+enter',
          'command': 'composer.newline',
          'when': 'composerFocus',
        },
      ]);

      await tester.pumpWidget(wrap(CommandShortcuts(
        registry: registry,
        whenContext: WhenContext()..composerFocus = true,
        keymap: keymap,
        child: const Scaffold(body: Center(child: TextField())),
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();

      await pressChord(tester, LogicalKeyboardKey.enter, LogicalKeyboardKey.shiftLeft);
      expect(sent, 1);
    });

    testWidgets('nav.back pops the enclosing navigator', (tester) async {
      final registry = CommandRegistry();
      final keymap = Keymap.parse([
        {'key': 'alt+left', 'command': 'nav.back'},
      ]);

      await tester.pumpWidget(wrap(CommandShortcuts(
        registry: registry,
        whenContext: WhenContext(),
        keymap: keymap,
        child: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push<void>(
                MaterialPageRoute<void>(
                  builder: (_) => const Scaffold(body: Text('pushed')),
                ),
              ),
              child: const Text('push'),
            ),
          ),
        ),
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.text('push'));
      await tester.pumpAndSettle();
      expect(find.text('pushed'), findsOneWidget);

      // The command is dispatched through the registry (the pushed route
      // sits outside the CommandShortcuts focus hub, so the chord path is
      // covered by the dispatch tests above).
      registry.dispatch('nav.back');
      await tester.pumpAndSettle();

      expect(find.text('pushed'), findsNothing);
    });

    testWidgets('T116 navigation.back/forward drive the host nav-stack seams',
        (tester) async {
      final registry = CommandRegistry();
      var backs = 0;
      var forwards = 0;

      await tester.pumpWidget(wrap(CommandShortcuts(
        registry: registry,
        whenContext: WhenContext(),
        keymap: Keymap.empty,
        onNavigateBack: () async => backs++,
        onNavigateForward: () async => forwards++,
        child: const Scaffold(body: Text('nav')),
      )));
      await tester.pumpAndSettle();

      registry.dispatch('navigation.back');
      registry.dispatch('navigation.forward');
      await tester.pumpAndSettle();

      expect(backs, 1);
      expect(forwards, 1);
    });
  });
}
