import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';
import 'package:jhin/design/icon_registry.dart';
import 'package:jhin/sdui/demo_marker.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T100 acceptance: the chat frame — the content lane centered at the
/// `laneWidth` default (46rem / 72rem wide / full per the client `chatWidth`
/// switch, the upstream `--chat-content-max-width` recipes), the composer
/// seam divider (the painted `--background-image-composer-seam-above`
/// recipe), the composer prompt font size and the demo-marked header
/// toggles.
const String _goldenDir = String.fromEnvironment('T100_GOLDEN_DIR');

JhinTheme _design({Map<Object?, Object?> prefs = const {}}) => JhinTheme.from(
      colors: generate('light', '#101018', '#10b981'),
      prefs: prefs,
    );

class _Recorder {
  final List<Map<String, dynamic>> dispatched = [];
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
      runDirectives: (directives) async {},
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

/// The chat frame fixture: the wire shape ChatScreen emits — the header
/// row (title, status badge, two demo toggles, menu), the lane with the
/// scroll-faded timeline, the seam divider and the docked composer.
Map<String, Object?> _chatFrame({String laneWidth = '46rem'}) => {
      'type': 'column',
      'id': 'chat-frame',
      'gap': 0,
      'children': [
        {
          'type': 'row',
          'id': 'chat-header',
          'align': 'center',
          'gap': 8,
          'padding': [12, 16],
          'children': [
            {
              'type': 'text',
              'text': 'Fix the login bug',
              'fontSize': 14,
              'fontWeight': 600,
              'maxLines': 1,
            },
            {
              'type': 'badge',
              'id': 'runStatus',
              'label': 'Idle',
            },
            {'type': 'spacer'},
            {
              'type': 'icon_button',
              'id': 'chat_right_panel-toggle',
              'icon': 'view_sidebar',
              'demo': true,
              'action': {
                'op': 'setState',
                'id': 'chat_right_panel',
                'value': true,
              },
            },
            {
              'type': 'icon_button',
              'id': 'chat_terminal-toggle',
              'icon': 'dock',
              'demo': true,
              'action': {
                'op': 'setState',
                'id': 'chat_terminal',
                'value': true,
              },
            },
            {
              'type': 'menu',
              'trigger': {
                'type': 'icon_button',
                'icon': 'more_vert',
              },
              'items': [
                {
                  'label': 'Pin thread',
                  'icon': 'keep',
                  'action': {
                    'path': '/ui/action/pin',
                    'method': 'POST',
                    'name': 'pin',
                    'payload': {'id': 's-1'},
                  },
                },
              ],
            },
          ],
        },
        {
          'type': 'expanded',
          'child': {
            'type': 'container',
            'id': 'chat-lane',
            'direction': 'column',
            'gap': 0,
            'laneWidth': laneWidth,
            'children': [
              {
                'type': 'expanded',
                'flex': 1,
                'child': {
                  'type': 'scroll_fade',
                  'edge': 'top',
                  'child': {
                    'type': 'column',
                    'id': 'chat-timeline',
                    'gap': 8,
                    'children': [
                      {
                        'type': 'expanded',
                        'child': {
                          'type': 'list',
                          'id': 'messages',
                          'items': [
                            for (var i = 1; i <= 12; i++)
                              {
                                'type': 'text',
                                'id': 'row-$i',
                                'text': 'Timeline row $i',
                              },
                          ],
                        },
                      },
                      {
                        'type': 'stream_view',
                        'id': 'stream',
                        'topic': '/ui/stream/session/s-1?fromSeq=0',
                        'autoScroll': true,
                      },
                    ],
                  },
                },
              },
              {
                'type': 'box',
                'id': 'composer-seam',
                'height': 10,
                'alignment': 'center',
                'child': {'type': 'sized_box'},
                'gradient': {
                  'begin': 'bottomCenter',
                  'end': 'topCenter',
                  'colors': ['#2E000000', '#00000000'],
                },
              },
              {
                'type': 'container',
                'id': 'composer',
                'direction': 'row',
                'gap': 8,
                'align': 'center',
                'padding': 12,
                'children': [
                  {
                    'type': 'textarea',
                    'id': 'messageInput',
                    'label': 'Message',
                    'minLines': 1,
                    'maxLines': 8,
                    'flex': 1,
                  },
                  {
                    'type': 'button',
                    'label': 'Send',
                    'style': 'primary',
                    'icon': 'send',
                  },
                ],
              },
            ],
          },
        },
      ],
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, Object?> json, {
  JhinTheme? design,
  _Recorder? recorder,
  Size size = const Size(1200, 800),
}) async {
  final resolved = design ?? _design();
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

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('the lane caps the timeline at the laneWidth default (46rem)',
      (tester) async {
    await _pump(tester, _chatFrame());
    final list = tester.getSize(find.byType(ListView).first);
    expect(list.width, 46 * 16,
        reason: 'the 46rem lane at the default 16px interface size');
  });

  testWidgets('the wide chatWidth switch forces the 72rem lane', (tester) async {
    await _pump(
      tester,
      _chatFrame(laneWidth: '46rem'),
      design: _design(prefs: {'chatWidth': 'wide'}),
    );
    final list = tester.getSize(find.byType(ListView).first);
    expect(list.width, 72 * 16,
        reason: 'the client switch wins over the server default '
            '(the upstream data-chat-width override)');
  });

  testWidgets('the full chatWidth switch removes the cap', (tester) async {
    await _pump(
      tester,
      _chatFrame(laneWidth: '46rem'),
      design: _design(prefs: {'chatWidth': 'full'}),
    );
    final list = tester.getSize(find.byType(ListView).first);
    expect(list.width, 1200,
        reason: 'full width: no lane cap at the 1200px viewport');
  });

  testWidgets('the seam divider paints the composer-seam gradient',
      (tester) async {
    await _pump(tester, _chatFrame());
    final decorations = tester
        .widgetList<DecoratedBox>(find.byType(DecoratedBox))
        .where((box) => box.decoration is BoxDecoration)
        .map((box) => box.decoration as BoxDecoration)
        .where((decoration) => decoration.gradient is LinearGradient)
        .toList();
    expect(decorations, isNotEmpty);
    final gradient = decorations.first.gradient as LinearGradient;
    expect(gradient.begin, Alignment.bottomCenter);
    expect(gradient.end, Alignment.topCenter);
    expect(gradient.colors.first, const Color(0x2E000000),
        reason: 'the recipe shade rgb(0 0 0 / 18%)');
  });

  testWidgets('the composer field renders at the prompt font size',
      (tester) async {
    await _pump(tester, _chatFrame());
    final field = tester.widget<TextField>(find.byType(TextField).first);
    expect(field.style?.fontSize, 16,
        reason: 'the --font-size-prompt-touch floor (max(prompt, 16px))');
  });

  testWidgets('the header toggles dispatch inline setState and carry the '
      'demo marker', (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _chatFrame(), recorder: recorder);
    await tester.tap(find.byIcon(kIconRegistry['view_sidebar']!));
    await tester.pump();
    await tester.tap(find.byIcon(kIconRegistry['dock']!));
    await tester.pump();
    expect(recorder.dispatched.map((action) => action['op']), everyElement('setState'));
    expect(recorder.dispatched.map((action) => action['id']),
        containsAll(['chat_right_panel', 'chat_terminal']));
    // The shared demo tooltip marks both toggles as previews.
    final tooltips = tester
        .widgetList<Tooltip>(find.byType(Tooltip))
        .where((tooltip) => tooltip.message == kDemoTooltip);
    expect(tooltips, isNotEmpty);
  });

  testWidgets('golden: the chat frame at the 46rem lane (light)',
      (tester) async {
    await _pump(tester, _chatFrame(), size: const Size(1000, 700));
    if (goldens) {
      await expectLater(
          find.byType(MaterialApp), matchesGoldenFile(golden('chat-frame-46-light.png')));
    }
  });

  testWidgets('golden: the chat frame at the 72rem wide lane (light)',
      (tester) async {
    await _pump(
      tester,
      _chatFrame(laneWidth: '46rem'),
      design: _design(prefs: {'chatWidth': 'wide'}),
      size: const Size(1300, 700),
    );
    if (goldens) {
      await expectLater(find.byType(MaterialApp),
          matchesGoldenFile(golden('chat-frame-72-light.png')));
    }
  });

  test('the two golden frames differ on disk', () {
    if (!goldens) return;
    final normal = File('$_goldenDir/chat-frame-46-light.png');
    final wide = File('$_goldenDir/chat-frame-72-light.png');
    expect(normal.existsSync(), isTrue);
    expect(wide.existsSync(), isTrue);
    expect(wide.readAsBytesSync(), isNot(normal.readAsBytesSync()),
        reason: 'the wide lane must change the render');
  });
}
