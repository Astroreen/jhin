import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/icon_registry.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T91 tests: the `toast_stack` primitive — the positioned transient stack
/// with the 5 s undo pattern, the queueing, the dismiss button and the
/// direction.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb):
/// `hooks/showThreadUndoNotice.ts:104-112` (the 5 s undo window),
/// `components/sidebar/SidebarThreadUndoNotice.tsx:17-26` (the notice look:
/// label + `Undo` inline button) and `components/ui/toast.tsx:520,551,568`
/// (the toast viewport: `max-w-90` = 360 px, the corner dismiss orb
/// `toast.tsx:97-102`, the frontmost-newest stack).
const String _goldenDir = String.fromEnvironment('T91_GOLDEN_DIR');

final GlobalKey _shot = GlobalKey();

class _Spy {
  final List<Map<String, dynamic>> dispatched = [];
  final List<List<dynamic>> directiveLists = [];
}

RenderContext _ctx(UiState state, _Spy spy) => RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {
        spy.dispatched.add(action);
      },
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {
        spy.directiveLists.add(directives);
      },
      confirm: (message, onConfirm) {},
    );

Map<String, dynamic> _stack([
  List<Map<String, dynamic>>? items,
  Map<String, dynamic>? overrides,
]) =>
    {
      'type': 'toast_stack',
      'id': 'probe-toast-stack',
      'items': items ??
          [
            {'text': 'Thread pinned'},
          ],
      ...?overrides,
    };

/// Pumps the stack node under a [StatefulBuilder] so a test can re-render
/// the same tree with a patched node (the server-driven update path).
Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  _Spy? spy,
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
            body: StatefulBuilder(
              builder: (context, setState) => Builder(
                builder: (context) => _ctx(UiState(), spy ?? _Spy())
                    .build(context, UiNode.fromJson(node)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  // The portal visibility flip is a post-frame callback.
  await tester.pump(const Duration(milliseconds: 1));
}

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('an item shows and dismisses after its 5 s default window',
      (tester) async {
    await _pump(tester, _stack());
    expect(find.text('Thread pinned'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('Thread pinned'), findsNothing,
        reason: 'the default window elapsed');
  });

  testWidgets('a custom duration wins', (tester) async {
    await _pump(tester, _stack([
      {'text': 'Quick', 'duration': 1000},
    ]));
    await tester.pump(const Duration(milliseconds: 900));
    expect(find.text('Quick'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Quick'), findsNothing);
  });

  testWidgets('items queue: a re-render that adds an item shows it '
      'alongside the live one', (tester) async {
    final spy = _Spy();
    var node = _stack();
    tester.view.physicalSize = const Size(800, 600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: JhinDesignScope(
          design: JhinTheme.from(),
          child: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) => Builder(
                builder: (context) =>
                    _ctx(UiState(), spy).build(context, UiNode.fromJson(node)),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(find.text('Thread pinned'), findsOneWidget);

    // The server patches a second item into the node: the same tree
    // re-renders (didUpdateWidget), the live item survives and the new one
    // queues in.
    node = _stack([
      {'text': 'Thread pinned'},
      {'text': 'Saved'},
    ]);
    (tester.state(find.byType(StatefulBuilder)) as dynamic).setState(() {});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(find.text('Thread pinned'), findsOneWidget,
        reason: 'the live item survives the re-render');
    expect(find.text('Saved'), findsOneWidget,
        reason: 'the new item queued in');
  });

  testWidgets('the undo action dispatches and dismisses the notice',
      (tester) async {
    final spy = _Spy();
    await _pump(
      tester,
      _stack([
        {
          'text': 'Thread pinned',
          'action': {'op': 'setState', 'id': 'undo', 'value': true},
        },
      ]),
      spy: spy,
    );
    await tester.tap(find.text('Undo'));
    await tester.pump();
    expect(spy.dispatched, hasLength(1));
    expect(spy.dispatched.single['op'], 'setState');
    expect(find.text('Thread pinned'), findsNothing,
        reason: 'the undo consumes the notice');
  });

  testWidgets('a {client: […]} action list runs through the directive '
      'executor', (tester) async {
    final spy = _Spy();
    await _pump(
      tester,
      _stack([
        {
          'text': 'Thread pinned',
          'action': {
            'client': [
              {'op': 'setState', 'id': 'x', 'value': 1},
              {'op': 'toast', 'text': 'Undone'},
            ],
          },
        },
      ]),
      spy: spy,
    );
    await tester.tap(find.text('Undo'));
    await tester.pump();
    expect(spy.directiveLists, hasLength(1));
    expect(spy.directiveLists.single, hasLength(2));
    expect(find.text('Thread pinned'), findsNothing);
  });

  testWidgets('the dismiss button drops the notice early', (tester) async {
    await _pump(tester, _stack());
    expect(find.text('Thread pinned'), findsOneWidget);
    await tester.tap(find.byIcon(kIconRegistry['close']!));
    await tester.pump();
    expect(find.text('Thread pinned'), findsNothing);
  });

  testWidgets('direction top aligns the stack to the top edge',
      (tester) async {
    await _pump(tester, _stack(null, {'direction': 'top'}));
    expect(find.text('Thread pinned'), findsOneWidget);
    final item = tester.getTopLeft(find.text('Thread pinned')).dy;
    expect(item, lessThan(100), reason: 'the stack grows from the top edge');
  });

  testWidgets('direction bottom (the default) aligns the stack to the '
      'bottom edge', (tester) async {
    await _pump(tester, _stack());
    final item = tester.getTopLeft(find.text('Thread pinned')).dy;
    expect(item, greaterThan(400),
        reason: 'the stack grows from the bottom edge');
  });

  testWidgets('an unknown direction degrades to bottom', (tester) async {
    await _pump(tester, _stack(null, {'direction': 'left'}));
    final item = tester.getTopLeft(find.text('Thread pinned')).dy;
    expect(item, greaterThan(400));
  });

  testWidgets('style error and success tint the leading icon', (tester) async {
    await _pump(tester, _stack([
      {'text': 'Saved', 'style': 'success'},
      {'text': 'Failed', 'style': 'error'},
    ]));
    expect(find.byIcon(kIconRegistry['check_circle']!), findsOneWidget);
    expect(find.byIcon(kIconRegistry['error']!), findsOneWidget);
  });

  testWidgets('items without text are skipped; a missing items array '
      'degrades visibly', (tester) async {
    await _pump(tester, _stack([
      {'style': 'success'},
      {'text': 'Kept'},
    ]));
    expect(find.text('Kept'), findsOneWidget);
    await _pump(tester, {'type': 'toast_stack', 'id': 'probe-toast-stack'});
    expect(find.text('Missing items'), findsOneWidget);
  });

  // One test per mode: a second pumpWidget inside the same test reuses the
  // MaterialApp element and does not re-theme (the frame would stay light).
  Future<void> goldenMode(WidgetTester tester, ThemeMode mode) async {
    final label = mode == ThemeMode.light ? 'light' : 'dark';
    await _pump(
      tester,
      _stack([
        {
          'text': 'Thread pinned',
          'action': {'op': 'setState', 'id': 'undo', 'value': true},
        },
        {'text': 'Saved', 'style': 'success'},
      ]),
      mode: mode,
    );
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('toast-stack-$label.png')));
    }
  }

  testWidgets('golden: the undo notice stack (light)',
      (tester) => goldenMode(tester, ThemeMode.light));
  testWidgets('golden: the undo notice stack (dark)',
      (tester) => goldenMode(tester, ThemeMode.dark));
}
