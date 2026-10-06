import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/boot/sdui_host.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/action_dispatcher.dart' as jhin;
import 'package:jhin/sdui/keyboard/keymap.dart';
import 'package:jhin/sdui/sdui_runtime.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/store/versioned_store.dart';

import '../sdui_fakes.dart';
import '../store/fixtures.dart';

/// The `keybind-edit` response of `jhin.ui` (`KeybindActions`): a `sheet`
/// with the `keyCapture` capture field plus Save/Cancel.
Map<String, dynamic> editSheet(String command) => {
      'type': 'container',
      'direction': 'column',
      'children': [
        {
          'type': 'text',
          'text': 'Press the new chord for $command',
          'style': 'h3',
        },
        {
          'type': 'input',
          'id': 'keyCapture',
          'label': 'Chord',
          'placeholder': 'Press a chord…',
          'required': true,
          'errorText': 'Press a chord first',
        },
        {
          'type': 'row',
          'children': [
            {
              'type': 'button',
              'label': 'Save',
              'action': {
                'path': '/ui/action/keybind-save',
                'method': 'POST',
                'name': 'keybind-save',
                'payload': {'command': command},
                'include': ['keyCapture'],
              },
            },
            {
              'type': 'button',
              'label': 'Cancel',
              'action': {'op': 'dismissDialog'},
            },
          ],
        },
      ],
    };

/// The Settings → Keyboard section of `SettingsScreen`: one `list_row` per
/// command (chord + Edit + Reset) plus the Restore-defaults action.
Map<String, dynamic> settingsNode(Map<String, String> chords) => {
      'type': 'screen',
      'title': 'Settings',
      'body': {
        'type': 'container',
        'direction': 'column',
        'children': [
          {'type': 'text', 'text': 'Keyboard', 'style': 'h2'},
          for (final entry in chords.entries)
            {
              'type': 'list_row',
              'title': entry.key,
              'subtitle': entry.value,
              'trailing': {
                'type': 'row',
                'children': [
                  {
                    'type': 'button',
                    'label': 'Edit',
                    'action': {
                      'path': '/ui/action/keybind-edit',
                      'method': 'POST',
                      'name': 'keybind-edit',
                      'payload': {'command': entry.key},
                    },
                  },
                  {
                    'type': 'button',
                    'label': 'Reset',
                    'action': {
                      'path': '/ui/action/keybind-reset',
                      'method': 'POST',
                      'name': 'keybind-reset',
                      'payload': {'command': entry.key},
                    },
                  },
                ],
              },
            },
          {
            'type': 'button',
            'label': 'Restore defaults',
            'action': {
              'path': '/ui/action/keybind-restore',
              'method': 'POST',
              'name': 'keybind-restore',
            },
          },
        ],
      },
    };

void main() {
  late InMemoryStringStore prefs;
  late AppStorage storage;
  late KeymapStore store;
  late ScriptedTransport transport;

  setUp(() {
    prefs = InMemoryStringStore();
    storage = AppStorage(prefs: prefs, secrets: InMemoryStringStore());
    store = KeymapStore(storage);
    transport = ScriptedTransport();
    transport.routes['/_jhin/bootstrap'] = sduiPayload(
      entry: 'settings',
      screens: {
        'settings': settingsNode({
          'composer.send': 'mod+enter',
          'palette.open': 'ctrl+k',
        }),
      },
    );
    transport.onPost = (path, body) {
      final payload =
          (body as Map)['payload'] as Map<String, dynamic>? ?? const {};
      switch (path) {
        case '/ui/action/keybind-edit':
          return {
            'client': [
              {
                'op': 'dialog',
                'kind': 'sheet',
                'node': editSheet('${payload['command']}'),
              },
            ],
          };
        default:
          return {
            'client': [
              {'op': 'dismissDialog'},
              {'op': 'toast', 'text': 'Saved'},
            ],
          };
      }
    };
  });

  Future<void> pumpHost(WidgetTester tester) async {
    await store.load();
    await tester.pumpWidget(MaterialApp(
      home: SduiHost(
        profile: const ServerProfile(
            id: 'p1', label: 'home', url: 'https://home'),
        storage: storage,
        transport: transport,
        renderer: SduiRuntime(transport: transport, keymapStore: store),
        keymapStore: store,
      ),
    ));
    await tester.pumpAndSettle();
  }

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

  Finder keyCaptureField(WidgetTester tester) {
    final field = find.byType(TextField);
    expect(field, findsOneWidget);
    return field;
  }

  testWidgets('rows render the commands and their chords', (tester) async {
    await pumpHost(tester);
    expect(find.text('Keyboard'), findsOneWidget);
    expect(find.text('composer.send'), findsOneWidget);
    expect(find.text('mod+enter'), findsOneWidget);
    expect(find.text('palette.open'), findsOneWidget);
    expect(find.text('ctrl+k'), findsOneWidget);
    expect(find.text('Edit'), findsNWidgets(2));
    expect(find.text('Reset'), findsNWidgets(2));
    expect(find.text('Restore defaults'), findsOneWidget);
  });

  testWidgets('the edit sheet captures a real key chord and Save persists it',
      (tester) async {
    await pumpHost(tester);
    await tester.tap(find.text('Edit').first);
    await tester.pumpAndSettle();
    expect(find.text('Press the new chord for composer.send'), findsOneWidget);

    // Focus the capture field and press a real chord: the keystroke becomes
    // the chord spec instead of typing.
    await tester.tap(keyCaptureField(tester));
    await tester.pumpAndSettle();
    await pressChord(tester, LogicalKeyboardKey.enter,
        [LogicalKeyboardKey.controlLeft, LogicalKeyboardKey.shiftLeft]);

    final controller =
        tester.widget<TextField>(keyCaptureField(tester)).controller!;
    expect(controller.text, 'mod+shift+enter');
    expect(store.byCommand, isEmpty); // nothing persisted yet

    // Save persists the override through the client-owned action side effect.
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(store.byCommand, {'composer.send': 'mod+shift+enter'});
    // Flush the response toast timer before teardown.
    await tester.pump(const Duration(seconds: 5));
    expect(payloadOf(prefs, StoreKeys.keybindings), {
      'rules': [
        {'command': 'composer.send', 'keys': 'mod+shift+enter'}
      ]
    });

    // The live keymap is re-resolved immediately (no restart).
    expect(
      store.rules,
      [
        {'command': 'composer.send', 'keys': 'mod+shift+enter'}
      ],
    );
  });

  test('a bare modifier capture fails validation and never saves', () async {
    // A bare modifier yields no chord, so the keyCapture field stays empty;
    // the required rule then reports the node's inline errorText.
    final capture = UiNode.fromJson({
      'type': 'input',
      'id': kKeyCaptureFieldId,
      'required': true,
      'errorText': 'Press a chord first',
    });
    expect(jhin.ActionDispatcher.validateField(capture, ''), 'Press a chord first');

    // A keybind-save without a captured chord persists nothing.
    await store.applyAction(kKeybindSaveAction, {'command': 'composer.send'});
    expect(store.byCommand, isEmpty);
    expect(payloadOf(prefs, StoreKeys.keybindings), isNull);
  });

  testWidgets('Reset reverts one command to its server default',
      (tester) async {
    await pumpHost(tester);
    await store.setOverride('composer.send', 'mod+shift+enter');
    await store.setOverride('palette.open', 'mod+p');

    await tester.tap(find.text('Reset').first);
    await tester.pumpAndSettle();
    expect(store.byCommand, {'palette.open': 'mod+p'});
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('Restore defaults clears every override', (tester) async {
    await pumpHost(tester);
    await store.setOverride('composer.send', 'mod+shift+enter');
    await store.setOverride('palette.open', 'mod+p');

    await tester.tap(find.text('Restore defaults'));
    await tester.pumpAndSettle();
    expect(store.rules, isEmpty);
    expect(payloadOf(prefs, StoreKeys.keybindings), {'rules': []});
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('an old chord after a rebind no longer fires the command',
      (tester) async {
    await pumpHost(tester);
    await tester.tap(find.text('Edit').first);
    await tester.pumpAndSettle();
    await tester.tap(keyCaptureField(tester));
    await tester.pumpAndSettle();
    await pressChord(tester, LogicalKeyboardKey.enter,
        [LogicalKeyboardKey.controlLeft, LogicalKeyboardKey.shiftLeft]);
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5));

    // Effective keymap right after Save: the new chord owns composer.send
    // and the old chord resolves to nothing.
    final host = tester.widget<SduiHost>(find.byType(SduiHost));
    final keymap = Keymap.resolve(
      const [
        {'key': 'mod+enter', 'command': 'composer.send', 'when': 'composerFocus'},
      ],
      store.rules,
    ).withDefaults(const []);
    expect(host.keymapStore, same(store));
    expect(keymap.rules.single.command, 'composer.send');
    expect(keymap.rules.single.chord,
        KeyChord.parse('mod+shift+enter'));
  });
}
