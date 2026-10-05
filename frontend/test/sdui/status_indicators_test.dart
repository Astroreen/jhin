import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/status_indicators.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/primitives/progress.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T92 tests: the duty-cycled status indicators — the `progress`
/// `statusPulse` modes (`pulse`/`ping`/`skeleton`), the complete-indicator
/// rule (`value: 1.0` never animates), the reduced-motion collapse and the
/// `ThreadStatusIndicators` cluster (spinner = pulse, unread = ping).
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the
/// `status-pulse` keyframes (`index.css:302-315`, steps(6)), the
/// `status-ping` keyframes (`index.css:317-327`, steps(8) burst over the
/// first 40%), the `skeleton` keyframes (`index.css:283-299`, steps(4)),
/// the status pill wearing `animate-status-pulse`
/// (`components/Sidebar.logic.ts:1158-1231` +
/// `components/ThreadStatusIndicators.tsx:817-868`).
///
/// The frame-count assertion samples the rendered opacity at 120 Hz over
/// one 2 s cycle (the way a 120 Hz display drives the compositor) and
/// counts the discrete changes — the acceptance bound is ≤ 16 frames per
/// cycle (the measured counts: pulse 12, ping 8).
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

Future<void> _pumpNode(
  WidgetTester tester,
  Map<String, dynamic> node, {
  JhinTheme? design,
  ThemeMode mode = ThemeMode.light,
}) async {
  final d = design ?? JhinTheme.from();
  tester.view.physicalSize = const Size(300, 200);
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

/// One 120 Hz frame: 1 s / 120 = 8333⅓ µs.
const Duration _frame120 = Duration(milliseconds: 8, microseconds: 333);

/// Counts the discrete rendered-opacity changes over one 2 s cycle pumped
/// at 120 Hz (240 frames).
Future<int> _opacityChanges(WidgetTester tester) async {
  var changes = 0;
  double? previous;
  for (var i = 0; i < 240; i++) {
    await tester.pump(_frame120);
    final opacity = tester.widget<Opacity>(find.byType(Opacity)).opacity;
    if (previous != null && opacity != previous) changes++;
    previous = opacity;
  }
  return changes;
}

void main() {
  testWidgets('statusPulse pulse renders the stepped status dot',
      (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-pulse',
      'kind': 'linear',
      'statusPulse': 'pulse',
    });
    expect(find.byType(JhinStatusIndicator), findsOneWidget);
    // t=0.5 lands on the low plateau: opacity 0.5 exactly.
    await tester.pump(const Duration(milliseconds: 1000));
    expect(tester.widget<Opacity>(find.byType(Opacity)).opacity, 0.5);
  });

  testWidgets('the pulse steps at most 16 frames per 2 s cycle at 120 Hz',
      (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-pulse',
      'statusPulse': 'pulse',
    });
    final changes = await _opacityChanges(tester);
    // The measured count is 12 (steps(6) × 2 segments); the acceptance
    // bound is ≤ 16 — a continuous animation would count ~239.
    expect(changes, lessThanOrEqualTo(16),
        reason: 'the duty cycle must render a handful of discrete frames');
    expect(changes, greaterThanOrEqualTo(8),
        reason: 'the pulse must actually step, not freeze');
  });

  testWidgets('statusPulse ping bursts the ring over the first 40%',
      (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-ping',
      'statusPulse': 'ping',
    });
    // Mid-burst (t=0.2): ring opacity 0.45, scale 1.375.
    await tester.pump(const Duration(milliseconds: 400));
    final ring = tester.widget<Opacity>(find.byType(Opacity));
    expect(ring.opacity, closeTo(0.45, 1e-9));
    final scale = tester.widget<Transform>(find.ancestor(
        of: find.byType(Opacity), matching: find.byType(Transform)).first);
    expect(scale.transform.getMaxScaleOnAxis(), closeTo(1.375, 1e-9));
    // After the burst (t=0.7): the ring holds invisible.
    await tester.pump(const Duration(milliseconds: 1000));
    expect(tester.widget<Opacity>(find.byType(Opacity)).opacity, 0);
  });

  testWidgets('the ping steps at most 16 frames per 2 s cycle at 120 Hz',
      (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-ping',
      'statusPulse': 'ping',
    });
    final changes = await _opacityChanges(tester);
    // The measured count is 8 (steps(8) × 1 burst segment).
    expect(changes, lessThanOrEqualTo(16),
        reason: 'the duty cycle must render a handful of discrete frames');
    expect(changes, greaterThanOrEqualTo(4),
        reason: 'the ping must actually step, not freeze');
  });

  testWidgets('statusPulse skeleton runs the 2.4 s shimmer', (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-skeleton',
      'statusPulse': 'skeleton',
    });
    // t=1.2 lands inside the low plateau: opacity 0.55.
    await tester.pump(const Duration(milliseconds: 1200));
    expect(tester.widget<Opacity>(find.byType(Opacity)).opacity, 0.55);
  });

  testWidgets('a complete indicator (value 1.0) never animates',
      (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-complete',
      'kind': 'linear',
      'value': 1.0,
      'statusPulse': 'ping',
    });
    expect(find.byType(JhinStatusIndicator), findsNothing,
        reason: 'the complete bar wins over the mode');
    expect(find.byType(Opacity), findsNothing);
    final bar = tester.widget<LinearProgressIndicator>(
        find.byType(LinearProgressIndicator));
    expect(bar.value, 1.0);
    // Five more frames: the render stays the static complete bar.
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(
        tester.widget<LinearProgressIndicator>(
            find.byType(LinearProgressIndicator)).value,
        1.0);
  });

  testWidgets('reduced motion collapses every mode to the static dot',
      (tester) async {
    final design = JhinTheme.from(prefs: const {'reducedMotion': true});
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-pulse',
      'statusPulse': 'pulse',
    }, design: design);
    expect(find.byType(JhinStatusIndicator), findsOneWidget);
    expect(find.byType(Opacity), findsNothing,
        reason: 'no ticker runs under reduced motion');
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byType(Opacity), findsNothing);
  });

  testWidgets('an unknown mode keeps the plain bar', (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-unknown',
      'statusPulse': 'blink',
    });
    expect(find.byType(JhinStatusIndicator), findsNothing,
        reason: 'only the documented modes route to the indicator');
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
  });

  testWidgets('statusPulse none keeps the plain bar', (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-none',
      'statusPulse': 'none',
    });
    expect(find.byType(JhinStatusIndicator), findsNothing);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
  });

  testWidgets('ThreadStatusIndicators composes spinner = pulse, '
      'unread = ping', (tester) async {
    final design = JhinTheme.from();
    await tester.pumpWidget(
      RepaintBoundary(
        key: _shot,
        child: MaterialApp(
          theme: design.light,
          darkTheme: design.dark,
          home: JhinDesignScope(
            design: design,
            child: const Scaffold(
              body: Center(
                child: ThreadStatusIndicators(working: true, unread: true),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    final indicators =
        tester.widgetList<JhinStatusIndicator>(find.byType(JhinStatusIndicator))
            .toList();
    expect(indicators, hasLength(2));
    expect(indicators[0].mode, 'pulse');
    expect(indicators[1].mode, 'ping');
  });

  testWidgets('ThreadStatusIndicators renders nothing without states',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: JhinDesignScope(
        design: JhinTheme.from(),
        child: const Scaffold(body: ThreadStatusIndicators()),
      ),
    ));
    await tester.pump();
    expect(find.byType(JhinStatusIndicator), findsNothing);
  });

  testWidgets('golden: the pulse dot mid-cycle (light)', (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-pulse',
      'statusPulse': 'pulse',
    }, mode: ThemeMode.light);
    await tester.pump(const Duration(milliseconds: 1000));
    if (_goldenDir.isNotEmpty) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(Uri.file('$_goldenDir/status-pulse-light.png')));
    }
  });

  testWidgets('golden: the pulse dot mid-cycle (dark)', (tester) async {
    await _pumpNode(tester, {
      'type': 'progress',
      'id': 'probe-pulse',
      'statusPulse': 'pulse',
    }, mode: ThemeMode.dark);
    await tester.pump(const Duration(milliseconds: 1000));
    if (_goldenDir.isNotEmpty) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(Uri.file('$_goldenDir/status-pulse-dark.png')));
    }
  });
}
