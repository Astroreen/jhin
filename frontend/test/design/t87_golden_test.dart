import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T87 goldens: the glass dialog blur, the composer shadow and the
/// safe-area helpers, rendered on the Flutter VM target (flutter_test) —
/// the web target's `BackdropFilter` cost is UNVERIFIED (§15.4) and the
/// QA evidence records the target used.
///
/// The pixel goldens land in `String.fromEnvironment('T87_GOLDEN_DIR')`
/// when the QA harness provides it (absolute path); the QA writes them
/// with `flutter test --update-goldens` and then re-runs without it to
/// verify. Without the define the tests assert structure only.
///
/// The degradation (a platform without backdrop support renders the solid
/// fill, index.css:339-341) is asserted through
/// [JhinGlass.debugBackdropSupport]; the QA `--fail` path proves the
/// harness catches the broken variant with a fixture test.
const String _goldenDir = String.fromEnvironment('T87_GOLDEN_DIR');

final GlobalKey _shot = GlobalKey();

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

/// The glass dialog node (the server-shaped JSON).
const Map<String, dynamic> _glassDialog = {
  'type': 'dialog',
  'glass': true,
  'title': 'Deploy preview',
  'content': {
    'type': 'text',
    'text': 'The backdrop behind this panel is blurred and saturated.',
  },
  'actions': [
    {'type': 'button', 'label': 'Close', 'style': 'secondary'},
  ],
};

/// The composer surface node (the server-shaped JSON of
/// `ChatScreen.composer`).
const Map<String, dynamic> _composer = {
  'type': 'container',
  'id': 'composer',
  'direction': 'row',
  'gap': 8,
  'align': 'center',
  'children': [
    {'type': 'text', 'text': 'Message'},
  ],
};

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  ThemeMode mode = ThemeMode.light,
  EdgeInsets padding = EdgeInsets.zero,
}) async {
  final design = JhinTheme.fallback();
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(padding: padding),
      child: MaterialApp(
        theme: design.light,
        darkTheme: design.dark,
        themeMode: mode,
        home: JhinDesignScope(
          design: design,
          child: Scaffold(body: child),
        ),
      ),
    ),
  );
  await tester.pump();
}

/// The high-contrast striped backdrop the glass panel sits over: the blur
/// is visible against it (and provably different from the solid render).
Widget _stripes(BuildContext context) {
  final design = JhinDesignScope.of(context);
  final accent = design.colorOf('accent') ?? Colors.purple;
  final canvas = design.colorOf('canvas') ?? Colors.black;
  return Column(
    children: [
      for (var i = 0; i < 12; i++)
        Expanded(child: ColoredBox(color: i.isEven ? accent : canvas)),
    ],
  );
}

/// The dialog-over-stripes scene, captured for the goldens. The scene
/// expands to the full boundary: the body hands out loose constraints and
/// a Stack with only positioned children would otherwise size to the
/// panel, leaving the rest of the golden transparent.
Widget _dialogScene(BuildContext context, UiNode node) {
  final harness = _Harness();
  return SizedBox.expand(
    child: Stack(
      children: [
        Positioned.fill(child: Builder(builder: _stripes)),
        Align(
          alignment: Alignment.center,
          child: harness.ctx.build(context, node),
        ),
      ],
    ),
  );
}

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  Future<void> shot(WidgetTester tester, String name) async {
    if (!goldens) return;
    await expectLater(find.byKey(_shot), matchesGoldenFile(golden(name)));
  }

  tearDownAll(() {
    JhinGlass.debugBackdropSupport = null;
  });

  testWidgets('the glass dialog blurs the backdrop (light)', (tester) async {
    await _pump(
      tester,
      RepaintBoundary(
        key: _shot,
        child: Builder(
          builder: (context) =>
              _dialogScene(context, UiNode.fromJson(_glassDialog)),
        ),
      ),
    );
    // The glass treatment is live: the composed backdrop filter (blur
    // first, then the saturation matrix) rides the panel.
    final filters = tester.widgetList<BackdropFilter>(
      find.byType(BackdropFilter),
    );
    expect(filters, isNotEmpty);
    await shot(tester, 'dialog-glass-light.png');
  });

  testWidgets('the glass dialog blurs the backdrop (dark)', (tester) async {
    await _pump(
      tester,
      RepaintBoundary(
        key: _shot,
        child: Builder(
          builder: (context) =>
              _dialogScene(context, UiNode.fromJson(_glassDialog)),
        ),
      ),
      mode: ThemeMode.dark,
    );
    expect(find.byType(BackdropFilter), findsWidgets);
    await shot(tester, 'dialog-glass-dark.png');
  });

  testWidgets(
    'without backdrop support the dialog degrades to the solid fill',
    (tester) async {
      JhinGlass.debugBackdropSupport = false;
      await _pump(
        tester,
        RepaintBoundary(
          key: _shot,
          child: Builder(
            builder: (context) =>
                _dialogScene(context, UiNode.fromJson(_glassDialog)),
          ),
        ),
      );
      // The degradation: no backdrop filter anywhere in the dialog — the
      // solid fill wins (index.css:339-341).
      expect(find.byType(BackdropFilter), findsNothing);
      await shot(tester, 'dialog-solid-light.png');
    },
  );

  testWidgets('the blur is visible: the glass and solid renders differ', (
    tester,
  ) async {
    if (!goldens) return;
    final glass = File('$_goldenDir/dialog-glass-light.png');
    final solid = File('$_goldenDir/dialog-solid-light.png');
    if (!glass.existsSync() || !solid.existsSync()) return;
    expect(
      glass.readAsBytesSync(),
      isNot(solid.readAsBytesSync()),
      reason: 'the glass golden must visibly differ from the solid fill',
    );
  });

  testWidgets('the composer surface carries the composer shadow and the '
      'bottom safe-area inset', (tester) async {
    final harness = _Harness();
    await _pump(
      tester,
      RepaintBoundary(
        key: _shot,
        child: Builder(
          builder: (context) => ColoredBox(
            color: JhinDesignScope.materialOf(context).colorScheme.surface,
            child: Align(
              alignment: Alignment.bottomCenter,
              child: harness.ctx.build(context, UiNode.fromJson(_composer)),
            ),
          ),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(12, 24, 20, 34),
    );
    // The composer shadow (index.css:193-194) on the surface box.
    final shadows = tester.widgetList<DecoratedBox>(
      find.byWidgetPredicate(
        (widget) =>
            widget is DecoratedBox &&
            widget.decoration is BoxDecoration &&
            (widget.decoration as BoxDecoration).boxShadow != null,
      ),
    );
    expect(shadows, isNotEmpty);
    final composerShadow = shadows
        .map((box) => (box.decoration as BoxDecoration).boxShadow!)
        .expand((list) => list)
        .first;
    expect(composerShadow.offset, const Offset(0, 12));
    expect(composerShadow.blurRadius, 28);
    expect(composerShadow.spreadRadius, -18);
    // The bottom safe-area inset rides outside the shadow box.
    final insets = tester.widgetList<Padding>(find.byType(Padding));
    expect(
      insets.any(
        (padding) => padding.padding == const EdgeInsets.only(bottom: 34),
      ),
      isTrue,
      reason: 'the composer applies pb-safe (MediaQuery.padding.bottom)',
    );
    await shot(tester, 'composer-shadow.png');
  });

  testWidgets('the safe-area helpers apply the four sides', (tester) async {
    late EdgeInsets resolved;
    await _pump(
      tester,
      RepaintBoundary(
        key: _shot,
        child: Builder(
          builder: (context) {
            resolved = jhinSafeAreaPadding(
              context,
              top: true,
              bottom: true,
              left: true,
              right: true,
            );
            // Opaque scene: the surface frame around the raised inset area,
            // so the golden shows the safe-area frame itself.
            return ColoredBox(
              color: JhinDesignScope.materialOf(context).colorScheme.surface,
              child: Padding(
                padding: resolved,
                child: SizedBox.expand(
                  child: ColoredBox(
                    color: JhinDesignScope.materialOf(
                      context,
                    ).colorScheme.surfaceContainerHighest,
                  ),
                ),
              ),
            );
          },
        ),
      ),
      padding: const EdgeInsets.fromLTRB(12, 24, 20, 34),
    );
    expect(resolved, const EdgeInsets.fromLTRB(12, 24, 20, 34));
    await shot(tester, 'safe-area.png');
  });

  testWidgets('the skeleton mid-animation frame is the stepped 0.55 dip', (
    tester,
  ) async {
    final harness = _Harness();
    await _pump(
      tester,
      RepaintBoundary(
        key: _shot,
        child: Builder(
          builder: (context) => ColoredBox(
            color: JhinDesignScope.materialOf(context).colorScheme.surface,
            child: Center(
              child: SizedBox(
                width: 200,
                child: harness.ctx.build(
                  context,
                  UiNode.fromJson(const {
                    'type': 'skeleton',
                    'variant': 'rect',
                    'height': 16,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    // 55% into the 2.4s cycle (the fake clock advances exactly): inside the
    // 50-92% hold at the stepped dip — the mid-animation frame the duty
    // cycle renders between its discrete updates.
    await tester.pump(const Duration(milliseconds: 1320));
    final opacity = tester.widget<Opacity>(find.byType(Opacity).first);
    expect(opacity.opacity, 0.55);
    await shot(tester, 'skeleton-stepped.png');
  });
}
