import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/primitives/scroll_fade.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T92 tests: the `scroll_fade` primitive — the alpha fade over a
/// scrollable's edge, the upstream mask recipes ported to a dstIn
/// ShaderMask.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the
/// `topbar-scroll-fade` utility (`index.css:420-457`, the static seven-stop
/// band the messages timeline wears at `chat/MessagesTimeline.tsx:1377`),
/// the `virtualized-scroll-fade` recipe (`index.css:461-476` +
/// `components/ui/scroll-area.tsx:14-20`) with the scroll-position toggle
/// of `components/CommandPaletteResults.tsx:103-113` (an edge fades while
/// more than 1 px hides beyond it), and the 1.5rem fade height
/// (`index.css:127`).
///
/// The gradient shapes are asserted through the exposed
/// `scrollFadeBandMask` / `scrollFadeEdgesScrolled` helpers with synthetic
/// metrics; the rendered fade is proven by the pixel goldens (the QA
/// harness writes them with `T92_GOLDEN_DIR` and re-runs them
/// byte-stable). Direct `toByteData` readback hangs on this host's
/// software-rendered flutter_tester, so no test samples pixels itself —
/// the virtualized toggle is proven by the rest/scrolled golden pair
/// differing on disk.
const String _goldenDir = String.fromEnvironment('T92_GOLDEN_DIR');

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

/// A scrollable body tall enough to scroll: twenty opaque 40 px rows.
Map<String, dynamic> _body() => {
      'type': 'scroll',
      'children': [
        for (var i = 0; i < 20; i++)
          {
            'type': 'box',
            'height': 40,
            'color': '#445566',
            'child': {'type': 'text', 'text': 'Row $i'},
          },
      ],
    };

Map<String, dynamic> _scrollFade([Map<String, dynamic>? overrides]) => {
      'type': 'scroll_fade',
      'id': 'probe-scroll-fade',
      'edge': 'top',
      'height': 24,
      'mode': 'topbar',
      'child': _body(),
      ...?overrides,
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  JhinTheme? design,
  ThemeMode mode = ThemeMode.light,
  Size size = const Size(300, 300),
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
              child: SizedBox(
                width: size.width,
                height: size.height,
                child: Builder(
                  builder: (context) =>
                      _ctx(UiState()).build(context, UiNode.fromJson(node)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  // The scroll metrics notification rides a microtask after the frame.
  await tester.pump();
  await tester.pump();
}

FixedScrollMetrics _metrics({required double pixels}) => FixedScrollMetrics(
      minScrollExtent: 0,
      maxScrollExtent: 500,
      pixels: pixels,
      viewportDimension: 300,
      axisDirection: AxisDirection.down,
      devicePixelRatio: 1.0,
    );

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  testWidgets('topbar mode wraps the child in the dstIn mask',
      (tester) async {
    await _pump(tester, _scrollFade());
    final mask = tester.widget<ShaderMask>(find.byType(ShaderMask));
    expect(mask.blendMode, BlendMode.dstIn);
    expect(find.text('Row 0'), findsOneWidget,
        reason: 'the child renders under the mask');
  });

  testWidgets('a missing child degrades visibly', (tester) async {
    await _pump(tester, {
      'type': 'scroll_fade',
      'id': 'probe-scroll-fade',
      'edge': 'top',
    });
    expect(find.text('Missing child'), findsOneWidget);
  });

  testWidgets('an unknown edge and mode degrade to the defaults',
      (tester) async {
    await _pump(tester, _scrollFade({'edge': 'diagonal', 'mode': 'weird'}));
    expect(find.byType(ShaderMask), findsOneWidget,
        reason: 'unknown edge -> top, unknown mode -> topbar (still masked)');
  });

  test('the band mask scales the topbar stops into the fade fraction', () {
    final leading = scrollFadeBandMask(
      bandStops: kScrollFadeTopbarStops,
      bandAlphas: kScrollFadeTopbarAlphas,
      fraction: 0.5,
      trailing: false,
    );
    // The seven band stops scale to half the bounds, then opaque to 1.
    expect(leading.stops, [0.0, 0.05, 0.12, 0.21, 0.31, 0.41, 0.5, 1.0]);
    expect(leading.colors.first.alpha, 0);
    expect(leading.colors[3].alpha, closeTo(0.58 * 255, 0.5));
    expect(leading.colors.last.alpha, 255);

    final trailing = scrollFadeBandMask(
      bandStops: kScrollFadeTopbarStops,
      bandAlphas: kScrollFadeTopbarAlphas,
      fraction: 0.5,
      trailing: true,
    );
    // The mirror: opaque from the start, the band descends to the far edge
    // (the mirrored stops carry floating-point noise — compare closely).
    expect(trailing.stops.length, 8);
    expect(trailing.stops.first, 0.0);
    expect(trailing.stops[1], closeTo(0.5, 1e-9));
    expect(trailing.stops[2], closeTo(0.59, 1e-9));
    expect(trailing.stops[3], closeTo(0.69, 1e-9));
    expect(trailing.stops[4], closeTo(0.79, 1e-9));
    expect(trailing.stops[5], closeTo(0.88, 1e-9));
    expect(trailing.stops[6], closeTo(0.95, 1e-9));
    expect(trailing.stops.last, 1.0);
    expect(trailing.colors.first.alpha, 255);
    expect(trailing.colors.last.alpha, 0);
  });

  test('the virtualized band is the plain two-stop ramp', () {
    final mask = scrollFadeBandMask(
      bandStops: kScrollFadeVirtualizedStops,
      bandAlphas: kScrollFadeVirtualizedAlphas,
      fraction: 0.25,
      trailing: false,
    );
    expect(mask.stops, [0.0, 0.25, 1.0]);
    expect(mask.colors.first.alpha, 0);
    expect(mask.colors[1].alpha, 255);
    expect(mask.colors.last.alpha, 255);
  });

  test('the scrolled-edge rule follows the upstream 1 px threshold', () {
    // At the top: only the trailing edge hides content.
    expect(scrollFadeEdgesScrolled(_metrics(pixels: 0)),
        (leading: false, trailing: true));
    // Scrolled 2 px: both edges hide content.
    expect(scrollFadeEdgesScrolled(_metrics(pixels: 2)),
        (leading: true, trailing: true));
    // At the exact 1 px threshold: still at rest (the upstream `> 1`).
    expect(scrollFadeEdgesScrolled(_metrics(pixels: 1)),
        (leading: false, trailing: true));
    // At the end: only the leading edge hides content.
    expect(scrollFadeEdgesScrolled(_metrics(pixels: 500)),
        (leading: true, trailing: false));
    // The per-edge mapping.
    expect(scrollFadeEdgeScrolled(ScrollFadeEdge.top, _metrics(pixels: 2)),
        isTrue);
    expect(scrollFadeEdgeScrolled(ScrollFadeEdge.top, _metrics(pixels: 0)),
        isFalse);
    expect(scrollFadeEdgeScrolled(ScrollFadeEdge.bottom, _metrics(pixels: 0)),
        isTrue);
    expect(
        scrollFadeEdgeScrolled(ScrollFadeEdge.bottom, _metrics(pixels: 500)),
        isFalse);
    expect(scrollFadeEdgeScrolled(ScrollFadeEdge.start, _metrics(pixels: 2)),
        isTrue);
    expect(scrollFadeEdgeScrolled(ScrollFadeEdge.end, _metrics(pixels: 500)),
        isFalse);
  });

  testWidgets('virtualized mode rebuilds when the scroll metrics report a '
      'scrolled edge', (tester) async {
    await _pump(tester, _scrollFade({'mode': 'virtualized'}));
    final before = tester.widget<ShaderMask>(find.byType(ShaderMask));
    // Dispatch scrolled-leading metrics from a context inside the fade —
    // the same path a real scrollable's metrics notification takes.
    final context = tester.state<State<Scrollable>>(find.byType(Scrollable)).context;
    ScrollMetricsNotification(
      metrics: _metrics(pixels: 100),
      context: context,
    ).dispatch(context);
    await tester.pump();
    final after = tester.widget<ShaderMask>(find.byType(ShaderMask));
    expect(identical(before, after), isFalse,
        reason: 'the scrolled metrics must rebuild the fade');
  });

  testWidgets('virtualized mode paints no fade while the edge is at rest, '
      'and fades once content hides beyond it', (tester) async {
    await _pump(tester, _scrollFade({'mode': 'virtualized'}));
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('scroll-fade-virtualized-rest.png')));
    }
    await tester.drag(
        find.byType(SingleChildScrollView), const Offset(0, -120));
    await tester.pump();
    await tester.pump();
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('scroll-fade-virtualized-scrolled.png')));
    }
  });

  test('the virtualized rest/scrolled golden pair differs on disk', () {
    if (!goldens) return;
    final rest = File('$_goldenDir/scroll-fade-virtualized-rest.png');
    final scrolled = File('$_goldenDir/scroll-fade-virtualized-scrolled.png');
    expect(rest.existsSync(), isTrue);
    expect(scrolled.existsSync(), isTrue);
    expect(
      scrolled.readAsBytesSync(),
      isNot(rest.readAsBytesSync()),
      reason: 'the scrolled frame must show the top fade the rest frame '
          'lacks — the toggle changed the render',
    );
  });

  testWidgets('golden: the topbar fade over a scrolled list (light)',
      (tester) async {
    await _pump(tester, _scrollFade(), mode: ThemeMode.light);
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('scroll-fade-light.png')));
    }
  });

  testWidgets('golden: the topbar fade over a scrolled list (dark)',
      (tester) async {
    await _pump(tester, _scrollFade(), mode: ThemeMode.dark);
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('scroll-fade-dark.png')));
    }
  });
}
