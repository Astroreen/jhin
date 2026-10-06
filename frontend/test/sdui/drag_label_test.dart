import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T99 acceptance: the drag choreography of the sectioned `list` — the
/// reveal-label chip (the upstream `dropVerbBadge` port), the accent tint
/// on the hovered target header, the pinned/active boundary labels, the
/// `Escape` cancel and the exactly-once drop dispatch of the mapped
/// lifecycle action.
const String _goldenDir = String.fromEnvironment('T99_GOLDEN_DIR');

final JhinTheme _design = JhinTheme.from(
  colors: generate('light', '#101018', '#10b981'),
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

/// The drag fixture: Pinned / Active / Settled sections (the boundary
/// labels on the first two), one row each. The active row targets Pinned
/// (`Pin`) and Settled (`Settle`); the pinned row targets Active
/// (`Unpin`); the settled row targets Active (`Un-settle`); the working
/// row is not draggable.
Map<String, Object?> _fixture({
  Map<String, Object?>? activeOverrides,
  int panelMs = 0,
}) =>
    {
      'type': 'list',
      'sections': [
        {
          'label': 'Pinned',
          'id': 'section-pinned',
          'collapsible': true,
          'uppercase': true,
          'boundaryLabel': 'Pinned',
          'items': [
            {
              'type': 'list_row',
              'id': 'session-row:p1',
              'title': 'Pinned row',
              'draggable': true,
              'dragLabel': {
                'type': 'row',
                'id': 'drag-label',
                'gap': 4,
                'children': [
                  {'type': 'icon', 'icon': 'push_pin', 'size': 12},
                  {'type': 'text', 'text': 'Pin'},
                ],
              },
              'dropTargets': [
                {
                  'id': 'section-active',
                  'label': 'Unpin',
                  'accentWhenHovered': true,
                  'action': {
                    'path': '/ui/action/unpin',
                    'method': 'POST',
                    'name': 'unpin',
                    'payload': {'id': 'p1'},
                  },
                },
              ],
            },
          ],
        },
        {
          'label': 'Active',
          'id': 'section-active',
          'collapsible': true,
          'uppercase': true,
          'boundaryLabel': 'Active',
          'items': [
            {
              'type': 'list_row',
              'id': 'session-row:a1',
              'title': 'Active row',
              'draggable': true,
              'dragLabel': {
                'type': 'row',
                'id': 'drag-label',
                'gap': 4,
                'children': [
                  {'type': 'icon', 'icon': 'push_pin', 'size': 12},
                  {'type': 'text', 'text': 'Pin'},
                ],
              },
              'dropTargets': [
                {
                  'id': 'section-pinned',
                  'label': 'Pin',
                  'accentWhenHovered': true,
                  'action': {
                    'path': '/ui/action/pin',
                    'method': 'POST',
                    'name': 'pin',
                    'payload': {'id': 'a1'},
                  },
                },
                {
                  'id': 'section-settled',
                  'label': 'Settle',
                  'accentWhenHovered': true,
                  'action': {
                    'path': '/ui/action/settle',
                    'method': 'POST',
                    'name': 'settle',
                    'payload': {'id': 'a1'},
                  },
                },
              ],
              ...?activeOverrides,
            },
          ],
        },
        {
          'label': 'Settled',
          'id': 'section-settled',
          'collapsible': true,
          'uppercase': true,
          'items': [
            {
              'type': 'list_row',
              'id': 'session-row:s1',
              'title': 'Settled row',
              'draggable': true,
              'dropTargets': [
                {
                  'id': 'section-active',
                  'label': 'Un-settle',
                  'accentWhenHovered': true,
                  'action': {
                    'path': '/ui/action/unsettle',
                    'method': 'POST',
                    'name': 'unsettle',
                    'payload': {'id': 's1'},
                  },
                },
              ],
            },
          ],
        },
        {
          'label': 'Working',
          'id': 'section-working',
          'collapsible': true,
          'uppercase': true,
          'items': [
            {
              'type': 'list_row',
              'id': 'session-row:w1',
              'title': 'Working row',
            },
          ],
        },
      ],
    };

Future<void> _pump(
  WidgetTester tester,
  Object? json, {
  _Recorder? recorder,
}) async {
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    theme: _design.light,
    home: Scaffold(
      body: JhinDesignScope(
        design: _design,
        child: Material(
          child: _Host(_ctx(UiState(), recorder ?? _Recorder()), node),
        ),
      ),
    ),
  ));
  await tester.pump();
}

/// Picks the active row up (long-press), lets the reveal delay pass and
/// holds the pointer down. The returned gesture must be finished by the
/// caller (`moveTo`/`up`).
Future<TestGesture> _pickUp(WidgetTester tester) async {
  final gesture = await tester.startGesture(
    tester.getCenter(find.text('Active row')),
  );
  // The long-press recognition (500 ms) plus the reveal delay (the
  // motion.panel token, 0 ms in the fixture).
  await tester.pump(const Duration(milliseconds: 600));
  await tester.pump(const Duration(milliseconds: 10));
  return gesture;
}

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('the boundary labels appear only while a drag is live and '
      'the reveal delay gates them', (tester) async {
    await _pump(tester, _fixture());
    // At rest: the uppercase headers only, no boundary rows.
    expect(find.text('PINNED'), findsOneWidget);
    expect(find.text('ACTIVE'), findsOneWidget);
    expect(find.text('Pinned'), findsNothing);
    expect(find.text('Active'), findsNothing);

    final gesture = await _pickUp(tester);
    // Revealed: the boundary rows replace the pinned/active headers.
    expect(find.text('Pinned'), findsOneWidget);
    expect(find.text('Active'), findsOneWidget);
    expect(find.text('PINNED'), findsNothing);
    // The Settled header keeps its resting chrome.
    expect(find.text('SETTLED'), findsOneWidget);
    await gesture.up();
    await tester.pump();
  });

  testWidgets('the hovered target header takes the accent colour and the '
      'chip shows the target badge word', (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _fixture(), recorder: recorder);
    final primary = _design.light.colorScheme.primary;

    final gesture = await _pickUp(tester);
    // Hover the Pinned boundary: the label takes the accent colour and
    // the chip shows Pin.
    await gesture.moveTo(tester.getCenter(find.text('Pinned')));
    await tester.pump();
    final boundary = tester.widget<Text>(find.text('Pinned'));
    expect(boundary.style?.color, primary);
    // The chip rides the in-place lifted row and the pointer-following
    // feedback card (the upstream badge sits on the stationary row; the
    // plan's chip follows the pointer — both carry it).
    expect(find.text('Pin'), findsNWidgets(2));

    // Hover the Settled header: the accent moves and the chip reads Settle.
    await gesture.moveTo(tester.getCenter(find.text('SETTLED')));
    await tester.pump();
    expect(tester.widget<Text>(find.text('Pinned')).style?.color,
        isNot(primary));
    expect(tester.widget<Text>(find.text('SETTLED')).style?.color, primary);
    expect(find.text('Settle'), findsNWidgets(2));
    expect(find.text('Pin'), findsNothing);

    // Leave every target (the row's own section is never one): no chip at
    // all (the upstream resting drag).
    await gesture.moveTo(tester.getCenter(find.text('Active')));
    await tester.pump();
    expect(tester.widget<Text>(find.text('Pinned')).style?.color,
        isNot(primary));
    expect(find.text('Settle'), findsNothing);
    await gesture.up();
    await tester.pump();
    expect(recorder.dispatched, isEmpty);
  });

  testWidgets('dropping on a target dispatches the mapped action exactly '
      'once', (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _fixture(), recorder: recorder);

    final gesture = await _pickUp(tester);
    await gesture.moveTo(tester.getCenter(find.text('Pinned')));
    await tester.pump();
    await gesture.up();
    await tester.pump();
    expect(recorder.dispatched, hasLength(1));
    expect(recorder.dispatched.single, {
      'path': '/ui/action/pin',
      'method': 'POST',
      'name': 'pin',
      'payload': {'id': 'a1'},
    });

    // The settle drop dispatches settle.
    final recorder2 = _Recorder();
    await _pump(tester, _fixture(), recorder: recorder2);
    final gesture2 = await _pickUp(tester);
    await gesture2.moveTo(tester.getCenter(find.text('SETTLED')));
    await tester.pump();
    await gesture2.up();
    await tester.pump();
    expect(recorder2.dispatched, hasLength(1));
    expect(recorder2.dispatched.single['name'], 'settle');
  });

  testWidgets('dropping on a non-target area cancels and dispatches '
      'nothing', (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _fixture(), recorder: recorder);

    final gesture = await _pickUp(tester);
    // Back onto the row's own section (never a target for itself).
    await gesture.moveTo(tester.getCenter(find.text('Active')));
    await tester.pump();
    expect(find.text('Pin'), findsNothing);
    await gesture.up();
    await tester.pump();
    expect(recorder.dispatched, isEmpty);

    // Outside the viewport entirely: still nothing.
    final recorder2 = _Recorder();
    await _pump(tester, _fixture(), recorder: recorder2);
    final gesture2 = await _pickUp(tester);
    // Below the viewport: outside every section region.
    await gesture2.moveTo(const Offset(10, 700));
    await tester.pump();
    await gesture2.up();
    await tester.pump();
    expect(recorder2.dispatched, isEmpty);
  });

  testWidgets('Escape cancels the drag and dispatches nothing', (tester) async {
    final recorder = _Recorder();
    await _pump(tester, _fixture(), recorder: recorder);

    final gesture = await _pickUp(tester);
    await gesture.moveTo(tester.getCenter(find.text('Pinned')));
    await tester.pump();
    expect(find.text('Pin'), findsNWidgets(2));

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    // The choreography collapsed: the boundary rows are gone, no chip.
    expect(find.text('Pin'), findsNothing);
    expect(find.text('Pinned'), findsNothing);
    expect(find.text('PINNED'), findsOneWidget);

    // Releasing the pointer after the cancel dispatches nothing.
    await gesture.up();
    await tester.pump();
    expect(recorder.dispatched, isEmpty);
  });

  testWidgets('rows without draggable never start a drag', (tester) async {
    await _pump(tester, _fixture());
    final gesture = await tester.startGesture(
      tester.getCenter(find.text('Working row')),
    );
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 10));
    expect(find.text('Pinned'), findsNothing);
    expect(find.text('PINNED'), findsOneWidget);
    await gesture.up();
    await tester.pump();
  });

  testWidgets('golden: the revealed drag over the pinned boundary (light)',
      (tester) async {
    tester.view.physicalSize = const Size(420, 720);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await _pump(tester, _fixture());
    final gesture = await _pickUp(tester);
    await gesture.moveTo(tester.getCenter(find.text('Pinned')));
    await tester.pump();
    if (goldens) {
      await expectLater(
          find.byType(MaterialApp), matchesGoldenFile(golden('drag-label-pin-light.png')));
    }
    await gesture.up();
    await tester.pump();
  });

  testWidgets('golden: the revealed drag over the settled header (light)',
      (tester) async {
    tester.view.physicalSize = const Size(420, 720);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await _pump(tester, _fixture());
    final gesture = await _pickUp(tester);
    await gesture.moveTo(tester.getCenter(find.text('SETTLED')));
    await tester.pump();
    if (goldens) {
      await expectLater(find.byType(MaterialApp),
          matchesGoldenFile(golden('drag-label-settle-light.png')));
    }
    await gesture.up();
    await tester.pump();
  });

  test('the two golden frames differ on disk', () {
    if (!goldens) return;
    final pin = File('$_goldenDir/drag-label-pin-light.png');
    final settle = File('$_goldenDir/drag-label-settle-light.png');
    expect(pin.existsSync(), isTrue);
    expect(settle.existsSync(), isTrue);
    expect(settle.readAsBytesSync(), isNot(pin.readAsBytesSync()),
        reason: 'the hovered target must change the render');
  });
}
