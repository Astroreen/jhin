// Golden gallery suite (T57): pins every primitive fixture from
// gallery_nodes.dart to a light and dark baseline PNG at a fixed 800x1200
// surface, density `comfortable`. One of these two never throws regardless
// of how degraded a fixture's props are (see frontend/test/design/
// universal_props_test.dart for the degrade-rules contract this relies on).
//
// Regenerate baselines after an intentional visual change:
//   scripts/qa/flutter-test.sh test/gallery --update-goldens
// See frontend/test/gallery/README.md for the full workflow (also used by
// T82's catalog-wide golden refresh).
import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'gallery_nodes.dart';

const _surfaceSize = Size(800, 1200);

/// Minimal [RenderContext] over a fresh [UiState] with no-op side channels —
/// goldens only need the widget tree to build, never to dispatch for real.
class _Harness {
  final state = UiState();

  late final RenderContext ctx = RenderContext(
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
}

class _Host extends StatelessWidget {
  const _Host(this.harness, this.node);

  final _Harness harness;
  final UiNode node;

  @override
  Widget build(BuildContext context) => harness.ctx.build(context, node);
}

// Mirrors frontend/lib/main.dart's MaterialApp wiring (theme/darkTheme/
// themeMode from JhinTheme) — a bare JhinDesignScope with no matching
// MaterialApp theme/darkTheme would make light and dark renders identical,
// since the token palette itself doesn't vary by appearance; only the two
// ColorScheme.fromSeed brightnesses baked into [JhinTheme.light]/[dark] do.
Future<void> _pumpFixture(
  WidgetTester tester,
  Map<String, dynamic> json,
  JhinTheme design,
  ThemeMode mode,
) async {
  final harness = _Harness();
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    theme: design.light,
    darkTheme: design.dark,
    themeMode: mode,
    home: Scaffold(
      body: JhinDesignScope(
        design: design,
        child: Material(child: _Host(harness, node)),
      ),
    ),
  ));
  await tester.pump();
}

void main() {
  final design = JhinTheme.from(density: 'comfortable');

  for (final fixture in galleryFixtures) {
    final id = fixture['id'] as String;

    testWidgets('$id (light)', (tester) async {
      tester.view.physicalSize = _surfaceSize;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await _pumpFixture(tester, fixture, design, ThemeMode.light);
      expect(tester.takeException(), isNull);

      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/$id-light.png'),
      );
    });

    testWidgets('$id (dark)', (tester) async {
      tester.view.physicalSize = _surfaceSize;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await _pumpFixture(tester, fixture, design, ThemeMode.dark);
      expect(tester.takeException(), isNull);

      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/$id-dark.png'),
      );
    });
  }
}
