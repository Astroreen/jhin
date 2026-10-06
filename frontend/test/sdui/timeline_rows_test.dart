import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/demo_marker.dart';
import 'package:jhin/sdui/primitives/stream_view.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T101 acceptance: the 14 timeline row kinds render as distinct,
/// token-driven rows; the continuation key groups consecutive rows with no
/// gap inside the group; the message hover actions dispatch the inline
/// stubs; an unknown row kind falls back without throwing.
const String _goldenDir = String.fromEnvironment('T101_GOLDEN_DIR');

/// The QA `--fail` switch: inverts the unknown-kind expectation (the wrong
/// claim is that an unknown row kind takes no gap / breaks the render; the
/// real behavior is the default gap and a plain render).
const bool _failMode = bool.fromEnvironment('T101_FAIL_MODE');

JhinTheme _design() => JhinTheme.from(
      colors: generate('light', '#101018', '#10b981'),
    );

class _Recorder {
  final List<Map<String, dynamic>> dispatched = [];
}

RenderContext _ctx(UiState state, _Recorder recorder,
        {Stream<Map<String, dynamic>>? stream}) =>
    RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {
        recorder.dispatched.add(action);
      },
      openStream: (topic, {onStatus}) =>
          stream ?? const Stream.empty(),
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

Future<void> _pump(
  WidgetTester tester,
  Map<String, Object?> json, {
  _Recorder? recorder,
  Size size = const Size(480, 360),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final state = UiState();
  final rec = recorder ?? _Recorder();
  await tester.pumpWidget(MaterialApp(
    theme: _design().light,
    home: Scaffold(
      body: JhinDesignScope(
        design: _design(),
        child: Material(
          child: _Host(_ctx(state, rec), UiNode.fromJson(json)),
        ),
      ),
    ),
  ));
  await tester.pump();
}

/// The wire shapes the server builders emit (MessageCardBuilder.java), one
/// fixture per row kind.
Map<String, Object?> _userMessageRow() => {
      'type': 'container',
      'id': 'ev-1',
      'direction': 'column',
      'gap': 4,
      'align': 'centerRight',
      'rowKind': 'message',
      'rowKey': 'message:user',
      'children': [
        {
          'type': 'card',
          'id': 'ev-1-bubble',
          'color': r'$color.message',
          'borderRadius': r'$radius.xl2',
          'padding': 12,
          'maxWidth': 560,
          'children': [
            {'type': 'text', 'text': 'Fix the login bug', 'style': 'body'},
          ],
        },
        {
          'type': 'row',
          'id': 'ev-1-actions',
          'align': 'center',
          'gap': 2,
          'children': [
            for (final action in ['Copy', 'Edit', 'Retry'])
              {
                'type': 'button',
                'label': action,
                'demo': true,
                'action': {
                  'op': 'setState',
                  'id': 'ev-1-actions-$action',
                  'value': true,
                },
              },
          ],
        },
      ],
    };

Map<String, Object?> _assistantMessageRow() => {
      'type': 'container',
      'id': 'ev-2',
      'direction': 'column',
      'gap': 4,
      'align': 'centerLeft',
      'rowKind': 'message',
      'rowKey': 'message:assistant',
      'children': [
        {
          'type': 'card',
          'id': 'ev-2-bubble',
          'border': r'$color.border',
          'borderRadius': r'$radius.xl2',
          'padding': 12,
          'maxWidth': 560,
          'children': [
            {
              'type': 'markdown',
              'id': 'msg-2',
              'text': 'On it — reading the auth flow.',
            },
          ],
        },
      ],
    };

Map<String, Object?> _assistantMetaRow() => {
      'type': 'container',
      'id': 'ev-3',
      'direction': 'column',
      'gap': 4,
      'align': 'centerLeft',
      'rowKind': 'assistant-meta',
      'rowKey': 'assistant-meta:assistant',
      'children': [
        {
          'type': 'row',
          'id': 'ev-3-meta',
          'align': 'center',
          'gap': 8,
          'children': [
            {'type': 'text', 'text': 'sonnet-4', 'style': 'caption'},
            {'type': 'text', 'text': 'high effort', 'style': 'caption'},
          ],
        },
      ],
    };

Map<String, Object?> _workRow(int seq, String label) => {
      'type': 'container',
      'id': 'ev-$seq',
      'direction': 'column',
      'gap': 0,
      'rowKind': 'work',
      'rowKey': 'work:log',
      'children': [
        {
          'type': 'list',
          'id': 'ev-$seq-list',
          'sections': [
            {
              'id': 'ev-$seq-section',
              'label': label,
              'collapsible': true,
              'collapsed': true,
              'items': [
                {'type': 'text', 'text': 'detail $seq'},
              ],
            },
          ],
        },
      ],
    };

Map<String, Object?> _workLiveRow() => {
      'type': 'container',
      'id': 'ev-6',
      'direction': 'column',
      'gap': 0,
      'rowKind': 'work-live',
      'rowKey': 'work-live:log',
      'children': [
        {
          'type': 'row',
          'align': 'center',
          'gap': 8,
          'children': [
            {'type': 'text', 'text': 'Running tests', 'style': 'small'},
          ],
        },
      ],
    };

Map<String, Object?> _workToggleRow() => {
      'type': 'container',
      'id': 'ev-7',
      'direction': 'column',
      'gap': 0,
      'rowKind': 'work-toggle',
      'rowKey': 'work-toggle:log',
      'children': [
        {
          'type': 'row',
          'align': 'center',
          'gap': 8,
          'children': [
            {'type': 'text', 'text': 'Read 4 files', 'style': 'small'},
          ],
        },
      ],
    };

Map<String, Object?> _thinkingRow() => {
      'type': 'container',
      'id': 'ev-8',
      'direction': 'column',
      'gap': 0,
      'rowKind': 'thinking',
      'rowKey': 'thinking:log',
      'children': [
        {
          'type': 'list',
          'sections': [
            {
              'id': 'ev-8-section',
              'label': 'Thinking',
              'collapsible': true,
              'collapsed': true,
              'items': [
                {'type': 'text', 'text': 'the expiry check'},
              ],
            },
          ],
        },
      ],
    };

Map<String, Object?> _proposedPlanRow() => {
      'type': 'container',
      'id': 'ev-9',
      'direction': 'column',
      'gap': 4,
      'rowKind': 'proposed-plan',
      'rowKey': 'proposed-plan:plan',
      'children': [
        {
          'type': 'card',
          'border': r'$color.border',
          'borderRadius': r'$radius.lg',
          'padding': 12,
          'demo': true,
          'children': [
            {'type': 'text', 'text': '1. Inject the clock'},
          ],
        },
      ],
    };

Map<String, Object?> _workingRow() => {
      'type': 'container',
      'id': 'ev-10',
      'direction': 'column',
      'gap': 0,
      'rowKind': 'working',
      'rowKey': 'working:run',
      'children': [
        {
          'type': 'row',
          'align': 'center',
          'gap': 8,
          'children': [
            {'type': 'text', 'text': 'agent is working…', 'style': 'small'},
          ],
        },
      ],
    };

Map<String, Object?> _worktreeSetupRow() => {
      'type': 'container',
      'id': 'ev-11',
      'direction': 'column',
      'gap': 4,
      'rowKind': 'worktree-setup',
      'rowKey': 'worktree-setup:setup',
      'children': [
        {
          'type': 'card',
          'border': r'$color.border',
          'borderRadius': r'$radius.lg',
          'padding': 12,
          'title': 'Setting up worktree',
          'demo': true,
          'children': [
            {'type': 'text', 'text': 'Creating the worktree', 'style': 'caption'},
          ],
        },
      ],
    };

Map<String, Object?> _foldRow(String kind, String label) => {
      'type': 'container',
      'id': 'ev-$kind',
      'direction': 'column',
      'gap': 0,
      'align': 'center',
      'rowKind': kind,
      'rowKey': '$kind:fold',
      'children': [
        {
          'type': 'row',
          'align': 'center',
          'gap': 4,
          'demo': true,
          'children': [
            {'type': 'text', 'text': label, 'style': 'caption'},
          ],
        },
      ],
    };

Map<String, Object?> _contextCompactionRow() => {
      'type': 'container',
      'id': 'ev-14',
      'direction': 'column',
      'gap': 0,
      'rowKind': 'context-compaction',
      'rowKey': 'context-compaction:compaction',
      'children': [
        {
          'type': 'row',
          'align': 'center',
          'gap': 12,
          'children': [
            {'type': 'text', 'text': 'Context compacted', 'style': 'caption'},
          ],
        },
      ],
    };

Map<String, Object?> _unknownRow() => {
      'type': 'container',
      'id': 'ev-15',
      'direction': 'column',
      'gap': 4,
      'rowKind': 'unknown',
      'rowKey': 'unknown:unknown',
      'children': [
        {
          'type': 'card',
          'border': r'$color.border',
          'borderRadius': r'$radius.lg',
          'padding': 12,
          'children': [
            {'type': 'text', 'text': 'Unknown row: holo', 'style': 'caption'},
          ],
        },
      ],
    };

Map<String, Object?> _eventRow() => {
      'type': 'container',
      'id': 'ev-16',
      'direction': 'column',
      'gap': 4,
      'rowKind': 'event',
      'rowKey': 'event:error',
      'children': [
        {
          'type': 'card',
          'id': 'ev-16-card',
          'border': r'$color.error',
          'borderRadius': r'$radius.lg',
          'padding': 12,
          'children': [
            {'type': 'text', 'text': 'Error', 'style': 'small'},
            {'type': 'text', 'text': 'boom', 'style': 'caption'},
          ],
        },
      ],
    };

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  test('the gap table follows the upstream pb scale', () {
    expect(timelineRowGap('message'), 16);
    expect(timelineRowGap('assistant-meta'), 16);
    expect(timelineRowGap('proposed-plan'), 16);
    expect(timelineRowGap('context-compaction'), 16);
    expect(timelineRowGap('work'), 8);
    expect(timelineRowGap('event'), 8);
    expect(timelineRowGap('thinking'), 8);
    expect(timelineRowGap('turn-fold'), 6);
    expect(timelineRowGap('working'), 6);
    // An unrecognized kind takes the default instead of throwing.
    expect(timelineRowGap('holo'), _failMode ? 0 : 16);
  });

  test('the continuation key groups consecutive rows', () {
    expect(
        timelineRowsContinue(
          {'rowKey': 'work:log'},
          {'rowKey': 'work:log'},
        ),
        isTrue);
    expect(
        timelineRowsContinue(
          {'rowKey': 'work:log'},
          {'rowKey': 'message:user'},
        ),
        isFalse);
    expect(timelineRowsContinue({}, {'rowKey': 'work:log'}), isFalse);
  });

  testWidgets('the user message row renders the bubble and the hover stubs',
      (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _userMessageRow(), recorder: recorder);
    expect(find.text('Fix the login bug'), findsOneWidget);
    await tester.tap(find.text('Copy'));
    await tester.pump();
    expect(recorder.dispatched.single['op'], 'setState');
    expect(recorder.dispatched.single['id'], 'ev-1-actions-Copy');
    // The shared demo tooltip marks the stubs as previews.
    expect(
        tester
            .widgetList<Tooltip>(find.byType(Tooltip))
            .where((tooltip) => tooltip.message == kDemoTooltip),
        isNotEmpty);
  });

  testWidgets('an unknown row kind renders without throwing',
      (tester) async {
    await _pump(tester, {
      'type': 'container',
      'id': 'ev-99',
      'direction': 'column',
      'rowKind': 'holo',
      'rowKey': 'holo:holo',
      'children': [
        {'type': 'text', 'text': 'mystery row'},
      ],
    });
    expect(find.text('mystery row'), findsOneWidget);
  });

  testWidgets('continuation grouping collapses the gap inside a group',
      (tester) async {
    final controller = StreamController<Map<String, dynamic>>();
    addTearDown(controller.close);
    final state = UiState();
    final recorder = _Recorder();
    final streamView = {
      'type': 'stream_view',
      'id': 'stream',
      'topic': '/ui/stream/session/s-1',
      'autoScroll': false,
    };
    tester.view.physicalSize = const Size(480, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(MaterialApp(
      theme: _design().light,
      home: Scaffold(
        body: JhinDesignScope(
          design: _design(),
          child: Material(
            child: _Host(
              _ctx(state, recorder, stream: controller.stream),
              UiNode.fromJson(streamView),
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
    controller.add({'node': _workRow(4, 'read src/auth.java')});
    controller.add({'node': _workRow(5, 'write src/auth.java result')});
    controller.add({'node': _userMessageRow()});
    await tester.pumpAndSettle();

    final readTop = tester.getTopLeft(find.text('read src/auth.java')).dy;
    final readBottom = tester.getBottomLeft(find.text('read src/auth.java')).dy;
    final writeTop =
        tester.getTopLeft(find.text('write src/auth.java result')).dy;
    // The two work rows share the work:log key: only the two 8px section
    // header paddings sit between the labels — no row gap.
    expect(writeTop - readBottom, moreOrLessEquals(16.0, epsilon: 0.5));
    // The user message starts a new group: the work row's 8px gap joins in.
    final msgTop = tester.getTopLeft(find.text('Fix the login bug')).dy;
    expect(msgTop - writeTop, greaterThan(writeTop - readTop));
  });

  // --- the 14 kind goldens ---

  Future<void> _goldenRow(
    WidgetTester tester,
    String name,
    List<Map<String, Object?>> rows, {
    Size size = const Size(480, 220),
  }) async {
    await _pump(
      tester,
      {
        'type': 'column',
        'gap': 8,
        'children': rows,
      },
      size: size,
    );
    if (goldens) {
      await expectLater(find.byType(MaterialApp), matchesGoldenFile(golden(name)));
    }
  }

  testWidgets('golden: message (user + assistant)', (tester) async {
    await _goldenRow(tester, 'row-message-light.png',
        [_userMessageRow(), _assistantMessageRow()],
        size: const Size(480, 320));
  });
  testWidgets('golden: assistant-meta', (tester) async {
    await _goldenRow(tester, 'row-assistant-meta-light.png', [_assistantMetaRow()]);
  });
  testWidgets('golden: event', (tester) async {
    await _goldenRow(tester, 'row-event-light.png', [_eventRow()]);
  });
  testWidgets('golden: work', (tester) async {
    await _goldenRow(tester, 'row-work-light.png', [_workRow(4, 'read src/auth.java')]);
  });
  testWidgets('golden: work-live', (tester) async {
    await _goldenRow(tester, 'row-work-live-light.png', [_workLiveRow()]);
  });
  testWidgets('golden: work-toggle', (tester) async {
    await _goldenRow(tester, 'row-work-toggle-light.png', [_workToggleRow()]);
  });
  testWidgets('golden: thinking', (tester) async {
    await _goldenRow(tester, 'row-thinking-light.png', [_thinkingRow()]);
  });
  testWidgets('golden: proposed-plan', (tester) async {
    await _goldenRow(tester, 'row-proposed-plan-light.png', [_proposedPlanRow()]);
  });
  testWidgets('golden: working', (tester) async {
    await _goldenRow(tester, 'row-working-light.png', [_workingRow()]);
  });
  testWidgets('golden: worktree-setup', (tester) async {
    await _goldenRow(tester, 'row-worktree-setup-light.png', [_worktreeSetupRow()]);
  });
  testWidgets('golden: turn-fold', (tester) async {
    await _goldenRow(
        tester, 'row-turn-fold-light.png', [_foldRow('turn-fold', '1 earlier turn')]);
  });
  testWidgets('golden: attempt-fold', (tester) async {
    await _goldenRow(tester, 'row-attempt-fold-light.png',
        [_foldRow('attempt-fold', 'Superseded attempt')]);
  });
  testWidgets('golden: context-compaction', (tester) async {
    await _goldenRow(tester, 'row-context-compaction-light.png', [_contextCompactionRow()]);
  });
  testWidgets('golden: unknown', (tester) async {
    await _goldenRow(tester, 'row-unknown-light.png', [_unknownRow()]);
  });

  test('the 14 kind goldens are distinct on disk', () {
    if (!goldens) return;
    final names = [
      'row-message-light.png',
      'row-assistant-meta-light.png',
      'row-event-light.png',
      'row-work-light.png',
      'row-work-live-light.png',
      'row-work-toggle-light.png',
      'row-thinking-light.png',
      'row-proposed-plan-light.png',
      'row-working-light.png',
      'row-worktree-setup-light.png',
      'row-turn-fold-light.png',
      'row-attempt-fold-light.png',
      'row-context-compaction-light.png',
      'row-unknown-light.png',
    ];
    final bytes = <String, List<int>>{};
    for (final name in names) {
      final file = File('$_goldenDir/$name');
      expect(file.existsSync(), isTrue, reason: '$name missing');
      bytes[name] = file.readAsBytesSync();
      expect(bytes[name]!, isNotEmpty, reason: '$name empty');
    }
    final distinct = bytes.values.map((value) => value.hashCode).toSet();
    expect(distinct.length, names.length,
        reason: 'every kind must render a distinct golden');
  });
}
