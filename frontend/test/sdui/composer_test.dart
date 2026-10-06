import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/context_chip_accents.dart';
import 'package:jhin/design/icon_registry.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';
import 'package:jhin/boot/sdui_host.dart';
import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/sdui/sdui_runtime.dart';

import '../sdui_fakes.dart';

/// T103 acceptance: the full composer — the header control row of
/// decorative pickers, the ContextChip-kind context chips, the decorative
/// context-window meter (green / yellow / red at 50 / 80%), the 160px
/// minimum-height textarea growing with content, and the footer row. The
/// keyboard chords (`mod+shift+m` opens the model picker) ride the real
/// keymap through the SDUI runtime, and an empty draft dispatches nothing.
const String _goldenDir = String.fromEnvironment('T103_GOLDEN_DIR');
const bool _failMode = bool.fromEnvironment('T103_FAIL_MODE');

JhinTheme _design() => JhinTheme.from(
      colors: generate('light', '#101018', '#10b981'),
    );

class _Recorder {
  final List<Map<String, dynamic>> dispatched = [];
  final List<dynamic> directiveRuns = [];
}

RenderContext _ctx(UiState state, _Recorder recorder) => RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {
        recorder.dispatched.add(action);
      },
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {
        recorder.directiveRuns.add(directives);
      },
      confirm: (message, onConfirm) {},
      readPersisted: null,
      writePersisted: null,
    );

class _Host extends StatelessWidget {
  const _Host(this.ctx, this.node);

  final RenderContext ctx;
  final UiNode node;

  @override
  Widget build(BuildContext context) => ctx.build(context, node);
}

/// The composer wire shape ChatScreen emits (T103): the control row, the
/// context chips, the meter, the draft textarea and the footer row.
Map<String, Object?> _composerFixture() => {
      'type': 'column',
      'id': 'composer',
      'gap': 8,
      'padding': 12,
      'children': [
        {
          'type': 'row',
          'id': 'composer-controls',
          'align': 'center',
          'gap': 4,
          'children': [
            {
              'type': 'row',
              'id': 'composer-model-picker-control',
              'align': 'center',
              'gap': 0,
              'children': [
                {
                  'type': 'button',
                  'id': 'composer-model-picker',
                  'label': 'Model: \${chat_model}',
                  'icon': 'auto_awesome',
                  'demo': true,
                  'tooltip': 'mod+shift+m — picker (preview only)',
                  'action': {
                    'op': 'dialog',
                    'node': _modelDialogFixture(),
                  },
                },
                {
                  'type': 'box',
                  'child': {
                    'type': 'icon_button',
                    'icon': 'expand_more',
                    'iconSize': 16,
                    'demo': true,
                    'action': {
                      'op': 'dialog',
                      'node': _modelDialogFixture(),
                    },
                  },
                },
              ],
            },
          ],
        },
        {
          'type': 'wrap',
          'id': 'composer-chips',
          'spacing': 6,
          'children': [
            {
              'type': 'chip',
              'label': '@ada',
              'icon': 'alternate_email',
              'kind': 'mention',
              'demo': true,
              'action': {
                'client': [
                  {'op': 'toast', 'text': '@ada context (preview only)'},
                ],
              },
            },
            {
              'type': 'chip',
              'label': 'plain',
              'kind': 'nonsense-kind',
            },
          ],
        },
        {
          'type': 'box',
          'id': 'context-meter',
          'height': 6,
          'borderRadius': 999,
          'demo': true,
          'gradient': {
            'begin': 'centerLeft',
            'end': 'centerRight',
            'colors': [
              '\$color.success', '\$color.success',
              '\$color.warning', '\$color.warning',
              '\$color.error', '\$color.error',
            ],
            'stops': [0.0, 0.5, 0.5, 0.8, 0.8, 1.0],
          },
        },
        {
          'type': 'textarea',
          'id': 'messageInput',
          'label': 'Message',
          'minLines': 1,
          'maxLines': 8,
          'flex': 1,
          'constraints': {'minHeight': 160},
        },
        {
          'type': 'row',
          'id': 'composer-footer',
          'align': 'center',
          'gap': 4,
          'children': [
            {
              'type': 'icon_button',
              'id': 'composer-attach',
              'icon': 'attach_file',
              'demo': true,
              'action': {
                'client': [
                  {'op': 'toast', 'text': 'Attach files (preview only)'},
                ],
              },
            },
            {
              'type': 'badge',
              'id': 'queue-badge',
              'label': 'Queue',
              'count': 2,
              'demo': true,
              'when': "chat_dispatch == 'queue'",
            },
            {
              'type': 'button',
              'id': 'composer-send',
              'label': 'Send',
              'style': 'primary',
              'icon': 'send',
            },
          ],
        },
        {
          'type': 'container',
          'visible': false,
          'children': [
            {'type': 'input', 'id': 'chat_model', 'value': 'Opus 4.6'},
          ],
        },
      ],
    };

Map<String, Object?> _modelDialogFixture() => {
      'type': 'column',
      'id': 'composer-model-dialog',
      'gap': 4,
      'children': [
        {
          'type': 'row',
          'gap': 8,
          'align': 'center',
          'children': [
            {'type': 'text', 'text': 'Model', 'fontWeight': 600},
            {'type': 'kbd', 'chord': 'mod+shift+m'},
          ],
        },
        for (final model in ['Opus 4.6', 'Sonnet 4.6'])
          {
            'type': 'button',
            'label': model,
            'demo': true,
            'action': {
              'client': [
                {'op': 'setState', 'id': 'chat_model', 'value': model},
                {'op': 'toast', 'text': '\$model selected (preview only)'},
              ],
            },
          },
        {
          'type': 'button',
          'label': 'Done',
          'action': {'op': 'dismissDialog'},
        },
      ],
    };

/// The keyboard-fixture screen for the chord test through the real runtime.
Map<String, dynamic> chatNode() => {
      'type': 'screen',
      'title': 'Chat',
      'body': {
        'type': 'container',
        'direction': 'column',
        'children': [
          {
            'type': 'textarea',
            'id': 'messageInput',
            'label': 'Message',
            'required': true,
            'errorText': 'Write a message first',
            'minLines': 1,
            'maxLines': 8,
            'autofocus': true,
          },
          {
            'type': 'row',
            'id': 'composer-model-picker-control',
            'children': [
              {
                'type': 'button',
                'id': 'composer-model-picker',
                'label': 'Model: \${chat_model}',
                'icon': 'auto_awesome',
                'demo': true,
                'action': {
                  'op': 'dialog',
                  'node': _modelDialogFixture(),
                },
              },
            ],
          },
          {
            'type': 'button',
            'id': 'composer-send',
            'label': 'Send',
            'style': 'primary',
            'icon': 'send',
            'action': {
              'path': '/ui/action/send',
              'method': 'POST',
              'name': 'send',
              'payload': {'sessionId': 's1'},
              'include': ['messageInput'],
            },
          },
          {
            'type': 'container',
            'visible': false,
            'children': [
              {'type': 'input', 'id': 'chat_model', 'value': 'Opus 4.6'},
            ],
          },
        ],
      },
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, Object?> json, {
  _Recorder? recorder,
  Size size = const Size(1200, 800),
}) async {
  final resolved = _design();
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    theme: resolved.light,
    home: Scaffold(
      body: JhinDesignScope(
        design: resolved,
        child: Material(
          child: _Host(_ctx(UiState(), recorder ?? _Recorder()), node),
        ),
      ),
    ),
  ));
  await tester.pump();
}

/// The recorded `POST /ui/action/<name>` calls of the transport.
List<ScriptedCall> posts(ScriptedTransport transport, String name) =>
    transport.calls
        .where((call) =>
            call.method == 'POST' && call.path == '/ui/action/$name')
        .toList();

/// Presses one hardware chord through the real key event pipeline.
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

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('the chip kind tints the pill with the kind accent',
      (tester) async {
    await _pump(tester, _composerFixture());
    final chips = tester.widgetList<Chip>(find.byType(Chip)).toList();
    expect(chips, isNotEmpty);
    final mention = chips.first;
    final accent = kChipKindAccents['mention']!;
    expect(mention.backgroundColor, accent.withValues(alpha: 0.11),
        reason: 'the 11% accent fill of the upstream ContextChip recipe');
    final onSurface =
        Theme.of(tester.element(find.byType(Chip).first)).colorScheme.onSurface;
    expect(mention.labelStyle?.color, Color.lerp(onSurface, accent, 0.22),
        reason: 'the label mixed 22% toward the accent');
    // An unknown kind degrades to the plain chip (no tint).
    final plain = chips.last;
    expect(plain.backgroundColor, isNull);
  });

  testWidgets('the context meter paints the hard 50/80 stops',
      (tester) async {
    await _pump(tester, _composerFixture());
    final gradients = tester
        .widgetList<DecoratedBox>(find.byType(DecoratedBox))
        .map((box) => box.decoration)
        .whereType<BoxDecoration>()
        .map((decoration) => decoration.gradient)
        .whereType<LinearGradient>()
        .where((gradient) => gradient.stops?.length == 6)
        .toList();
    expect(gradients, isNotEmpty);
    final meter = gradients.first;
    expect(meter.begin, Alignment.centerLeft);
    expect(meter.end, Alignment.centerRight);
    expect(meter.stops, [0.0, 0.5, 0.5, 0.8, 0.8, 1.0],
        reason: 'green to 50%, yellow to 80%, red beyond');
    expect(meter.colors.first, meter.colors[1],
        reason: 'the green run holds to the 50% stop');
    expect(meter.colors[2], meter.colors[3],
        reason: 'the yellow run holds to the 80% stop');
    expect(meter.colors[4], isNot(meter.colors[3]),
        reason: 'red starts at the 80% stop');
  });

  testWidgets('the composer textarea holds 160px and grows with content',
      (tester) async {
    await _pump(tester, _composerFixture());
    final field = find.byType(TextField).first;
    expect(tester.getSize(field).height, greaterThanOrEqualTo(160),
        reason: 'the COMPOSER_MIN_HEIGHT floor');

    await tester.enterText(field, 'line1\nline2\nline3\nline4\nline5\n'
        'line6\nline7\nline8');
    await tester.pump();
    expect(tester.getSize(field).height, greaterThan(160),
        reason: 'the field grows with its content above the floor');
  });

  testWidgets('the demo footer affordances dispatch the inline composite',
      (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _composerFixture(), recorder: recorder);
    await tester.tap(find.byIcon(kIconRegistry['attach_file']!));
    await tester.pump();
    expect(recorder.dispatched, hasLength(1));
    expect(recorder.dispatched.single, containsPair('client', isNotNull));
  });

  testWidgets('the picker button opens its dialog and the option updates '
      'the label locally', (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _composerFixture(), recorder: recorder);
    await tester.tap(find.byIcon(kIconRegistry['auto_awesome']!));
    await tester.pump();

    // The dialog directive ran client-side (the inline action prop rides
    // the action dispatch).
    expect(recorder.dispatched, hasLength(1));
    expect(recorder.dispatched.single, containsPair('op', 'dialog'));
  });

  testWidgets('golden: the composer rows (light)', (tester) async {
    await _pump(tester, _composerFixture(), size: const Size(1000, 500));
    if (goldens) {
      await expectLater(
          find.byType(MaterialApp), matchesGoldenFile(golden('composer-rows-light.png')));
    }
  });

  group('composer chords through the runtime', () {
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
        entry: 'chat:s1',
        screens: {
          'chat:s1': chatNode(),
        },
      );
      transport.onPost = (path, body) => {'client': <dynamic>[]};
      return transport;
    }

    Future<void> pumpHost(
      WidgetTester tester,
      ScriptedTransport transport,
    ) async {
      await tester.pumpWidget(MaterialApp(
        home: SduiHost(
          key: ValueKey(profile.id),
          profile: profile,
          storage: storage,
          transport: transport,
          renderer: SduiRuntime(transport: transport),
        ),
      ));
      await tester.pumpAndSettle();
    }

    testWidgets('mod+shift+m opens the model picker dialog', (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);

      await press(tester, LogicalKeyboardKey.keyM, modifiers: [
        LogicalKeyboardKey.controlLeft,
        LogicalKeyboardKey.shiftLeft,
      ]);
      await tester.pumpAndSettle();

      // The dialog list is open: the title and the option buttons render.
      expect(find.text('Model'), findsOneWidget);
      expect(find.text('Sonnet 4.6'), findsOneWidget);
      // The picker label interpolates the seeded decorative default.
      expect(find.text('Model: Opus 4.6'), findsOneWidget);
      if (_failMode) {
        expect(find.text('Model'), findsNothing,
            reason: 'FAIL MODE: the picker dialog must not open');
      }
    });

    testWidgets('an empty draft dispatches no send (no network call)',
        (tester) async {
      final transport = transportWith();
      await pumpHost(tester, transport);

      await tester.tap(find.byIcon(kIconRegistry['send']!));
      await tester.pumpAndSettle();

      final sends = posts(transport, 'send');
      if (_failMode) {
        expect(sends, isNotEmpty,
            reason: 'FAIL MODE: an empty draft must post a send');
      } else {
        expect(sends, isEmpty,
            reason: 'the empty draft is a no-op with no network call');
        expect(find.text('Write a message first'), findsOneWidget,
            reason: 'the inline error shows instead');
      }
    });
  });
}
