import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';
import 'package:jhin/sdui/demo_marker.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T93 tests: the `diff_view` primitive — the decorative diff renderer with
/// the unified and split views and the two colour schemes.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the stat label
/// (`components/chat/DiffStatLabel.tsx:38-47`), the stacked/split toggle
/// (`components/DiffPanel.tsx:892-901`, `:1146`), the lane tokens
/// (`index.css:2025-2028`, the blue-orange override `:2041-2045`) and the
/// line-background mixes (`lib/diffRendering.ts:348-380`).
///
/// The pixel goldens land in `String.fromEnvironment('T93_GOLDEN_DIR')`
/// when the QA harness provides it (absolute path): the 3-hunk fixture in
/// both views and both colour schemes, plus the demo-marker frame. The QA
/// writes them with `flutter test --update-goldens` and re-runs without it
/// to prove the frames are byte-stable. Without the define the tests assert
/// structure only.
const String _goldenDir = String.fromEnvironment('T93_GOLDEN_DIR');

final GlobalKey _shot = GlobalKey();

/// The 3-hunk fixture (the acceptance fixture): context, deletion and
/// addition lines, a meta row, gutter numbers on both sides.
Map<String, dynamic> _diffView([Map<String, dynamic>? overrides]) => {
      'type': 'diff_view',
      'id': 'diff-fixture',
      'file': 'lib/agent/run.ts',
      'language': 'typescript',
      'view': 'unified',
      'colorScheme': 'default',
      'stats': {'additions': 5, 'deletions': 2},
      'demo': true,
      'hunks': [
        {
          'header': '@@ -12,7 +12,9 @@ run loop',
          'lines': [
            {'kind': 'ctx', 'oldNo': 12, 'newNo': 12, 'text': 'for (final turn of turns) {'},
            {'kind': 'del', 'oldNo': 13, 'text': '  await runOne(turn);'},
            {'kind': 'add', 'newNo': 13, 'text': '  await runOne(turn, options);'},
            {'kind': 'add', 'newNo': 14, 'text': '  await report(turn);'},
            {'kind': 'ctx', 'oldNo': 14, 'newNo': 15, 'text': '}'},
          ],
        },
        {
          'header': '@@ -31,6 +33,8 @@ teardown',
          'lines': [
            {'kind': 'meta', 'text': '// hunk header context only'},
            {'kind': 'ctx', 'oldNo': 31, 'newNo': 33, 'text': '  cleanup();'},
            {'kind': 'add', 'newNo': 34, 'text': '  cleanup.sync();'},
          ],
        },
        {
          'header': '@@ -58,4 +62,6 @@ exports',
          'lines': [
            {'kind': 'del', 'oldNo': 58, 'text': 'export { run };'},
            {'kind': 'add', 'newNo': 62, 'text': 'export { run, runOne };'},
            {'kind': 'ctx', 'oldNo': 59, 'newNo': 63, 'text': '// end of file'},
          ],
        },
      ],
      ...?overrides,
    };

RenderContext _ctx(UiState state, {List<Map<String, dynamic>>? dispatched}) =>
    RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async => dispatched?.add(action),
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) {},
    );

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  JhinTheme? design,
  ThemeMode mode = ThemeMode.light,
  Size size = const Size(560, 420),
  RenderContext? ctx,
}) async {
  final d = design ?? JhinTheme.from();
  tester.view.physicalSize = size;
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
                    (ctx ?? _ctx(UiState())).build(context, UiNode.fromJson(node)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('unified view renders the stat header, hunk headers and line '
      'gutters', (tester) async {
    await _pump(tester, _diffView());
    // The stat header: green +5, red -2 (the DiffStatLabel pair).
    expect(find.text('+5'), findsOneWidget);
    expect(find.text('-2'), findsOneWidget);
    // The file header and the three hunk headers.
    expect(find.text('lib/agent/run.ts  ·  typescript'), findsOneWidget);
    expect(find.text('@@ -12,7 +12,9 @@ run loop'), findsOneWidget);
    expect(find.text('@@ -31,6 +33,8 @@ teardown'), findsOneWidget);
    expect(find.text('@@ -58,4 +62,6 @@ exports'), findsOneWidget);
    // The line texts render once (unified: one row per line).
    expect(find.text('  await runOne(turn);'), findsOneWidget);
    expect(find.text('  await runOne(turn, options);'), findsOneWidget);
    // The view toggle rides the header.
    expect(find.byTooltip('Unified view'), findsOneWidget);
    expect(find.byTooltip('Split view'), findsOneWidget);
  });

  testWidgets('split view pairs the old and new sides of every hunk',
      (tester) async {
    await _pump(tester, _diffView({'view': 'split'}));
    // The old side keeps the deletion, the new side the addition; the
    // context and meta rows render in both panes.
    expect(find.text('  await runOne(turn);'), findsOneWidget);
    expect(find.text('  await runOne(turn, options);'), findsOneWidget);
    expect(find.text('for (final turn of turns) {'), findsNWidgets(2));
    expect(find.text('// hunk header context only'), findsNWidgets(2));
  });

  testWidgets('toggling the view swaps the layout purely client-side — no '
      'dispatch, the patch overlay carries the choice', (tester) async {
    final state = UiState();
    final dispatched = <Map<String, dynamic>>[];
    final patches = <String, Map<String, dynamic>>{};
    final ctx = RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: patches,
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) => patches[id] = {...patches[id] ?? {}, ...props},
      navigate: (screen) {},
      dispatch: (action) async => dispatched.add(action),
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) {},
    );
    await _pump(tester, _diffView(), ctx: ctx);
    expect(find.text('  await runOne(turn, options);'), findsOneWidget);
    expect(find.text('  await runOne(turn);'), findsOneWidget);

    await tester.tap(find.byTooltip('Split view'));
    await tester.pump();
    // The split layout: the context row renders in both panes.
    expect(find.text('for (final turn of turns) {'), findsNWidgets(2));
    // No server round-trip: zero dispatches, the choice rides the patch.
    expect(dispatched, isEmpty);
    expect(patches['diff-fixture'], containsPair('view', 'split'));

    await tester.tap(find.byTooltip('Unified view'));
    await tester.pump();
    expect(find.text('for (final turn of turns) {'), findsOneWidget);
    expect(patches['diff-fixture'], containsPair('view', 'unified'));
  });

  testWidgets('colorScheme blue-orange swaps the lanes to the fixed '
      'blue/orange pair', (tester) async {
    await _pump(tester, _diffView({'colorScheme': 'blue-orange'}));
    final context = tester.element(find.text('+5'));
    final design = JhinDesignScope.of(context);
    final codeBg = design.colorOf('code') ??
        JhinDesignScope.materialOf(context).colorScheme.surfaceContainerHighest;
    final lanes = resolveDiffColors(
      scheme: JhinDiffColorScheme.blueOrange,
      themeAdded: kDiffAdditionFallback,
      themeRemoved: kDiffDeletionFallback,
      dark: false,
    );
    // The addition lane background is the blue mix, the deletion lane the
    // orange mix (the upstream data-diff-color-scheme mapping, 50% light).
    expect(
      tester.widgetList<ColoredBox>(
        find.byWidgetPredicate((widget) =>
            widget is ColoredBox &&
            widget.color == Color.lerp(codeBg, lanes.added, 0.5)),
      ),
      isNotEmpty,
      reason: 'the addition rows paint the blue lane mix',
    );
    expect(
      tester.widgetList<ColoredBox>(
        find.byWidgetPredicate((widget) =>
            widget is ColoredBox &&
            widget.color == Color.lerp(codeBg, lanes.removed, 0.5)),
      ),
      isNotEmpty,
      reason: 'the deletion rows paint the orange lane mix',
    );
  });

  testWidgets('an absent colorScheme follows the ambient switch (T86)',
      (tester) async {
    final design = JhinTheme.from(prefs: {'diffColorScheme': 'blue-orange'});
    await _pump(tester, _diffView()..remove('colorScheme'), design: design);
    final context = tester.element(find.text('+5'));
    final codeBg = design.colorOf('code') ??
        JhinDesignScope.materialOf(context).colorScheme.surfaceContainerHighest;
    final lanes = resolveDiffColors(
      scheme: JhinDiffColorScheme.blueOrange,
      themeAdded: kDiffAdditionFallback,
      themeRemoved: kDiffDeletionFallback,
      dark: false,
    );
    expect(
      tester.widgetList<ColoredBox>(
        find.byWidgetPredicate((widget) =>
            widget is ColoredBox &&
            widget.color == Color.lerp(codeBg, lanes.added, 0.5)),
      ),
      isNotEmpty,
      reason: 'the ambient blue-orange switch applied without the prop',
    );
  });

  testWidgets('demo: true renders the shared disabled-affordance marker',
      (tester) async {
    await _pump(tester, _diffView());
    expect(find.text('preview'), findsOneWidget,
        reason: 'the shared corner badge marks the decorative node');
    expect(find.byTooltip(kDemoTooltip), findsOneWidget,
        reason: 'the shared tooltip is attached');
  });

  testWidgets('a node without the demo marker renders bare', (tester) async {
    await _pump(tester, _diffView()..remove('demo'));
    expect(find.text('preview'), findsNothing);
    expect(find.byTooltip(kDemoTooltip), findsNothing);
  });

  testWidgets('missing hunks degrade visibly', (tester) async {
    await _pump(tester, {
      'type': 'diff_view',
      'id': 'diff-fixture',
      'demo': true,
    });
    expect(find.text('Missing hunks'), findsOneWidget);
  });

  testWidgets('malformed hunks and unknown line kinds degrade per line',
      (tester) async {
    await _pump(tester, {
      'type': 'diff_view',
      'id': 'diff-fixture',
      'demo': true,
      'hunks': [
        {
          'header': '@@ -1,2 +1,2 @@',
          'lines': [
            {'kind': 'banana', 'text': 'unknown kind renders as context'},
            {'kind': 'add', 'newNo': 2, 'text': 'added'},
            'a malformed string line',
            {'no': 'kind'},
          ],
        },
        'a malformed string hunk',
        {'no': 'header'},
      ],
    });
    expect(find.text('unknown kind renders as context'), findsOneWidget);
    expect(find.text('added'), findsOneWidget);
    expect(find.text('@@ -1,2 +1,2 @@'), findsOneWidget);
  });

  testWidgets('golden: unified view, default scheme (light)', (tester) async {
    await _pump(tester, _diffView());
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('diff-view-unified-default-light.png')));
    }
  });

  testWidgets('golden: unified view, blue-orange scheme (light)',
      (tester) async {
    await _pump(tester, _diffView({'colorScheme': 'blue-orange'}));
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('diff-view-unified-blue-orange-light.png')));
    }
  });

  testWidgets('golden: split view, default scheme (light)', (tester) async {
    await _pump(tester, _diffView({'view': 'split'}));
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('diff-view-split-default-light.png')));
    }
  });

  testWidgets('golden: split view, blue-orange scheme (light)',
      (tester) async {
    await _pump(tester, _diffView({'view': 'split', 'colorScheme': 'blue-orange'}));
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('diff-view-split-blue-orange-light.png')));
    }
  });

  testWidgets('golden: unified view, default scheme (dark)', (tester) async {
    await _pump(tester, _diffView(), mode: ThemeMode.dark);
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('diff-view-unified-default-dark.png')));
    }
  });

  test('the default and blue-orange golden frames differ on disk', () {
    if (!goldens) return;
    final def = File('$_goldenDir/diff-view-unified-default-light.png');
    final blue = File('$_goldenDir/diff-view-unified-blue-orange-light.png');
    expect(def.existsSync(), isTrue);
    expect(blue.existsSync(), isTrue);
    expect(blue.readAsBytesSync(), isNot(def.readAsBytesSync()),
        reason: 'the colour scheme must change the render');
  });
}
