import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T91 tests: the `hover_card` primitive — the hover-opened preview card
/// with the 500 ms default delay, the four placements, the touch
/// tap-and-hold, the nesting safety and the trigger-only degrade.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb):
/// `components/ThreadHoverCard.tsx:5-13` (the glass tooltip popup,
/// `max-w-80`), `components/Sidebar.tsx:438` (`side="right" align="start"
/// sideOffset={4}`) and `components/Sidebar.tsx:4996,5062` (the sidebar
/// hover delay — 150 ms there; the contract default is the plan's 500 ms,
/// docs/sdui.md §2.6).
///
/// The pixel goldens land in `String.fromEnvironment('T91_GOLDEN_DIR')`
/// (absolute path) when the QA harness provides it: the open card over its
/// trigger, light + dark.
const String _goldenDir = String.fromEnvironment('T91_GOLDEN_DIR');

final GlobalKey _shot = GlobalKey();

RenderContext _ctx(UiState state) => RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {},
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) {},
    );

Map<String, dynamic> _hoverCard([Map<String, dynamic>? overrides]) => {
      'type': 'hover_card',
      'id': 'probe-hover-card',
      'trigger': {'type': 'text', 'text': 'Hover trigger'},
      'content': {'type': 'text', 'text': 'Hover content'},
      ...?overrides,
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  JhinTheme? design,
  ThemeMode mode = ThemeMode.light,
}) async {
  final d = design ?? JhinTheme.from();
  tester.view.physicalSize = const Size(800, 600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _shot,
      child: MaterialApp(
        theme: d.light,
        darkTheme: d.dark,
        themeMode: mode,
        home: JhinDesignScope(
          design: d,
          child: Scaffold(
            body: Center(
              child: Builder(
                builder: (context) =>
                    _ctx(UiState()).build(context, UiNode.fromJson(node)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

/// Presses a mouse pointer onto the trigger and keeps it there; [after]
/// advances the fake clock (the open delay is a timer).
Future<void> _hover(
  WidgetTester tester, {
  int pointer = 7,
  Duration after = Duration.zero,
}) async {
  final gesture = await tester.createGesture(
      kind: PointerDeviceKind.mouse, pointer: pointer);
  final center = tester.getCenter(find.text('Hover trigger'));
  await gesture.addPointer(location: center);
  await gesture.moveTo(center);
  await tester.pump();
  if (after > Duration.zero) await tester.pump(after);
}

/// Moves the pointer off the trigger and card, then removes it — the leave
/// path (the close grace is a timer, advanced with [after]).
Future<void> _unhover(
  WidgetTester tester, {
  int pointer = 7,
  Duration after = Duration.zero,
}) async {
  final gesture = await tester.createGesture(
      kind: PointerDeviceKind.mouse, pointer: pointer);
  await gesture.moveTo(const Offset(700, 500));
  await tester.pump();
  await gesture.removePointer();
  await tester.pump();
  if (after > Duration.zero) await tester.pump(after);
}

final Finder _card = find.text('Hover content');

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('opens after the 500 ms default delay', (tester) async {
    await _pump(tester, _hoverCard());
    expect(_card, findsNothing);
    await _hover(tester, after: const Duration(milliseconds: 100));
    expect(_card, findsNothing, reason: '100 ms into a 500 ms delay');
    await tester.pump(const Duration(milliseconds: 450));
    expect(_card, findsOneWidget, reason: 'the delay elapsed');
  });

  testWidgets('a custom delay prop wins', (tester) async {
    await _pump(tester, _hoverCard({'delay': 50}));
    await _hover(tester, after: const Duration(milliseconds: 60));
    expect(_card, findsOneWidget);
  });

  testWidgets('closes when the pointer leaves trigger and card', (tester) async {
    await _pump(tester, _hoverCard());
    expect(_card, findsNothing);
    await _hover(tester, after: const Duration(milliseconds: 600));
    expect(_card, findsOneWidget);
    await _unhover(tester, after: const Duration(milliseconds: 200));
    expect(_card, findsNothing, reason: 'the pointer left; the grace elapsed');
  });

  testWidgets('placement right puts the card right of the trigger',
      (tester) async {
    await _pump(tester, _hoverCard({
      'placement': 'right',
      'delay': 0,
    }));
    await _hover(tester);
    await tester.pump(const Duration(milliseconds: 10));
    expect(_card, findsOneWidget);
    expect(tester.getCenter(_card).dx,
        greaterThan(tester.getCenter(find.text('Hover trigger')).dx));
  });

  testWidgets('placement bottom puts the card below the trigger',
      (tester) async {
    await _pump(tester, _hoverCard({
      'placement': 'bottom',
      'delay': 0,
    }));
    await _hover(tester);
    await tester.pump(const Duration(milliseconds: 10));
    expect(tester.getCenter(_card).dy,
        greaterThan(tester.getCenter(find.text('Hover trigger')).dy));
  });

  testWidgets('an unknown placement degrades to top', (tester) async {
    await _pump(tester, _hoverCard({
      'placement': 'diagonal',
      'delay': 0,
    }));
    await _hover(tester);
    await tester.pump(const Duration(milliseconds: 10));
    expect(tester.getCenter(_card).dy,
        lessThan(tester.getCenter(find.text('Hover trigger')).dy));
  });

  testWidgets('tap-and-hold opens on touch', (tester) async {
    await _pump(tester, _hoverCard());
    expect(_card, findsNothing);
    await tester.longPress(find.text('Hover trigger'), warnIfMissed: false);
    await tester.pump();
    expect(_card, findsOneWidget);
    // A second hold closes it again.
    await tester.longPress(find.text('Hover trigger'), warnIfMissed: false);
    await tester.pump();
    expect(_card, findsNothing);
  });

  testWidgets('a missing content degrades to the bare trigger (the '
      'universal tooltip still shows)', (tester) async {
    await _pump(tester, {
      'type': 'hover_card',
      'id': 'probe-hover-card',
      'tooltip': 'kept tooltip',
      'trigger': {'type': 'text', 'text': 'Hover trigger'},
    });
    expect(find.text('Missing trigger'), findsNothing);
    expect(find.byType(Tooltip), findsOneWidget);
    expect(find.byTooltip('kept tooltip'), findsOneWidget);
    await _hover(tester, after: const Duration(milliseconds: 600));
    expect(_card, findsNothing, reason: 'no content, no card');
  });

  testWidgets('a missing trigger degrades visibly', (tester) async {
    await _pump(tester, {
      'type': 'hover_card',
      'id': 'probe-hover-card',
      'content': {'type': 'text', 'text': 'Hover content'},
    });
    expect(find.text('Missing trigger'), findsOneWidget);
  });

  testWidgets('nesting-safe: a hover_card inside the content opens above '
      'the outer card', (tester) async {
    await _pump(tester, _hoverCard({
      'delay': 0,
      'content': {
        'type': 'column',
        'children': [
          {'type': 'text', 'text': 'Hover content'},
          {
            'type': 'hover_card',
            'id': 'inner-hover-card',
            'trigger': {'type': 'text', 'text': 'Inner trigger'},
            'content': {'type': 'text', 'text': 'Inner content'},
            'delay': 0,
          },
        ],
      },
    }));
    await _hover(tester);
    await tester.pump(const Duration(milliseconds: 10));
    expect(_card, findsOneWidget);
    // The same pointer travels from the trigger into the card and onto the
    // inner trigger (the card's own hover region keeps the outer card open
    // across the move — the nesting-safe bridge).
    final gesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse, pointer: 7);
    await gesture.moveTo(tester.getCenter(find.text('Inner trigger')));
    await tester.pump(const Duration(milliseconds: 10));
    expect(find.text('Inner content'), findsOneWidget,
        reason: 'the nested card opened inside the outer overlay entry');
    await gesture.removePointer();
    await tester.pump();
  });

  // One test per mode: a second pumpWidget inside the same test reuses the
  // MaterialApp element and does not re-theme (the frame would stay light).
  Future<void> goldenMode(WidgetTester tester, ThemeMode mode) async {
    final label = mode == ThemeMode.light ? 'light' : 'dark';
    await _pump(tester, _hoverCard({'delay': 0}), mode: mode);
    await _hover(tester);
    await tester.pump(const Duration(milliseconds: 10));
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('hover-card-$label.png')));
    }
  }

  testWidgets('golden: the open hover card (light)',
      (tester) => goldenMode(tester, ThemeMode.light));
  testWidgets('golden: the open hover card (dark)',
      (tester) => goldenMode(tester, ThemeMode.dark));
}
