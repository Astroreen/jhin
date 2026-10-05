import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T89 goldens + wiring tests: the five glass-capable surfaces (`card`,
/// `sheet`, `dialog`, `menu`, `banner`) with the level-3 glass group
/// (`glass` + `glassTint`), rendered on the Flutter VM target (flutter_test)
/// — the web target's `BackdropFilter` cost is UNVERIFIED (§15.4) and the
/// QA evidence records the target used.
///
/// The pixel goldens land in `String.fromEnvironment('T89_GOLDEN_DIR')`
/// when the QA harness provides it (absolute path): light + dark per glass
/// surface plus the degraded flat-fill frame for incapable renderers. The
/// QA writes them with `flutter test --update-goldens` and re-runs without
/// it to verify. Without the define the tests assert structure only.
///
/// The mapping under test (upstream index.css): `surface-glass` → card and
/// sheet (:334-342), `alert-glass` → banner (:344-374), `dialog-glass` +
/// `dialog-backdrop` → dialog (:376-398), `dropdown-glass` → menu
/// (:405-419). `glassTint` is the `--alert-glass-tint` wash — a 4% layer
/// of the colour over the glass fill (jhinGlassTintAlpha).
const String _goldenDir = String.fromEnvironment('T89_GOLDEN_DIR');

/// The design under test: the fallback theme plus the two tint tokens the
/// fixtures reference (`$color.destructive`, `$color.warning`) — the
/// generated server palette carries both names (PaletteGen status colors).
final JhinTheme _design = JhinTheme.from(colors: {
  'destructive': const Color(0xFFB3261E),
  'warning': const Color(0xFFB77716),
});

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

Map<String, dynamic> _glass(String type, Map<String, dynamic> extra) => {
      'type': type,
      'glass': true,
      'glassTint': r'$color.destructive',
      ...extra,
    };

/// The five glass surfaces (the server-shaped JSON).
final Map<String, Map<String, dynamic>> _surfaces = {
  'card': _glass('card', {
    'title': 'Glass card',
    'children': [
      {'type': 'text', 'text': 'Blurred backdrop card'},
    ],
  }),
  'sheet': _glass('sheet', {
    'title': 'Glass sheet',
    'body': {'type': 'text', 'text': 'Blurred backdrop sheet'},
  }),
  'dialog': _glass('dialog', {
    'title': 'Glass dialog',
    'content': {'type': 'text', 'text': 'Blurred backdrop dialog'},
    'actions': [
      {'type': 'button', 'label': 'Close', 'style': 'secondary'},
    ],
  }),
  'menu': _glass('menu', {
    'trigger': {'type': 'button', 'label': 'Open menu'},
    'items': [
      {'label': 'One'},
      {'label': 'Two'},
    ],
  }),
  'banner': {
    'type': 'banner',
    'glass': true,
    'glassTint': r'$color.warning',
    'content': {'type': 'text', 'text': 'Blurred backdrop banner'},
  },
};

/// The 4% wash colour of one glassTint value (the jhinGlassSurface rule).
Color _wash(Color tint) =>
    tint.withValues(alpha: (tint.a * jhinGlassTintAlpha).clamp(0.0, 1.0));

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  ThemeMode mode = ThemeMode.light,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: _design.light,
      darkTheme: _design.dark,
      themeMode: mode,
      home: JhinDesignScope(
        design: _design,
        child: Scaffold(body: child),
      ),
    ),
  );
  await tester.pump();
}

/// The high-contrast striped backdrop the glass panel sits over: the blur
/// and the tint wash are visible against it.
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

/// The surface-over-stripes scene, captured for the goldens. The scene
/// expands to the full boundary so a Stack with only positioned children
/// still fills the frame.
Widget _scene(BuildContext context, UiNode node) {
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

  // The four inline surfaces: card, sheet, dialog, banner.
  for (final entry in {
    'card': 'surface-glass',
    'sheet': 'surface-glass',
    'dialog': 'dialog-glass',
    'banner': 'alert-glass',
  }.entries) {
    for (final mode in [ThemeMode.light, ThemeMode.dark]) {
      final label = mode == ThemeMode.light ? 'light' : 'dark';
      testWidgets('the glass ${entry.key} renders the ${entry.value} '
          'treatment with the tint wash ($label)', (tester) async {
        final node = UiNode.fromJson(_surfaces[entry.key]!);
        await _pump(
          tester,
          RepaintBoundary(
            key: _shot,
            child: Builder(
              builder: (context) => _scene(context, node),
            ),
          ),
          mode: mode,
        );
        // The glass treatment is live: the composed backdrop filter rides
        // the panel.
        expect(find.byType(BackdropFilter), findsWidgets);
        // The tint wash: a 4% layer of the glassTint colour over the fill.
        final brightness =
            mode == ThemeMode.dark ? Brightness.dark : Brightness.light;
        final tintName = entry.key == 'banner' ? 'warning' : 'destructive';
        final tint = _design.colorOf(tintName, brightness: brightness);
        expect(tint, isNotNull, reason: 'the palette carries $tintName');
        expect(
          tester.widgetList<ColoredBox>(
            find.byWidgetPredicate(
              (widget) => widget is ColoredBox && widget.color == _wash(tint!),
            ),
          ),
          isNotEmpty,
          reason: 'the glassTint wash rides the ${entry.key} fill',
        );
        await shot(tester, 'glass-${entry.key}-$label.png');
      });
    }
  }

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    final label = mode == ThemeMode.light ? 'light' : 'dark';
    testWidgets('the glass menu opens with the dropdown-glass fill and tint '
        '($label)', (tester) async {
      // breakpoint 0: the popup presentation regardless of the test viewport.
      final node = UiNode.fromJson({
        ..._surfaces['menu']!,
        'breakpoint': 0,
      });
      await _pump(
        tester,
        RepaintBoundary(
          key: _shot,
          child: Builder(
            builder: (context) => _scene(context, node),
          ),
        ),
        mode: mode,
      );
      // The popup route cannot host a BackdropFilter (the documented
      // route-popup degradation): the recipe fill + tint ride the button's
      // `color` instead. The fallbacks mirror _menuGlassFill (the palette
      // carries no popover/foreground names).
      final context = find.byType(Scaffold).first.evaluate().first;
      final brightness =
          mode == ThemeMode.dark ? Brightness.dark : Brightness.light;
      final scheme = JhinDesignScope.materialOf(context).colorScheme;
      final recipe = JhinMenuGlassRecipe.of(
        _design.tokens.surface,
        brightness,
        popover:
            _design.colorOf('popover', brightness: brightness) ??
                scheme.surfaceContainerHighest,
        foreground:
            _design.colorOf('foreground', brightness: brightness) ??
                scheme.onSurface,
      );
      final button = tester.widget<PopupMenuButton<int>>(
        find.byType(PopupMenuButton<int>),
      );
      expect(
        button.color,
        Color.alphaBlend(
            _wash(_design.colorOf('destructive', brightness: brightness)!),
            recipe.fill),
      );
      await tester.tap(find.byType(PopupMenuButton<int>));
      await tester.pumpAndSettle();
      expect(find.byType(PopupMenuItem<int>), findsNWidgets(2));
      await shot(tester, 'glass-menu-$label.png');
    });
  }

  testWidgets('the glass menu sheet presentation carries the tint wash',
      (tester) async {
    final node = UiNode.fromJson({
      ..._surfaces['menu']!,
      'breakpoint': 100000,
    });
    await _pump(
      tester,
      RepaintBoundary(
        key: _shot,
        child: Builder(
          builder: (context) => _scene(context, node),
        ),
      ),
    );
    // Below the breakpoint the trigger opens the sheet presentation: the
    // trigger sits under an AbsorbPointer, the wrapping GestureDetector
    // owns the tap.
    await tester.tap(find.text('Open menu'));
    await tester.pumpAndSettle();
    // The sheet presentation hosts the full glass recipe: blur + wash.
    expect(find.byType(BackdropFilter), findsWidgets);
    expect(
      tester.widgetList<ColoredBox>(
        find.byWidgetPredicate((widget) =>
            widget is ColoredBox &&
            widget.color == _wash(_design.colorOf('destructive')!)),
      ),
      isNotEmpty,
    );
  });

  testWidgets(
    'without backdrop support every glass surface degrades to the flat fill '
    '(no blur, no tint wash)',
    (tester) async {
      JhinGlass.debugBackdropSupport = false;
      addTearDown(() => JhinGlass.debugBackdropSupport = null);
      for (final entry in _surfaces.entries) {
        await _pump(
          tester,
          RepaintBoundary(
            key: _shot,
            child: Builder(
              builder: (context) =>
                  _scene(context, UiNode.fromJson(entry.value)),
            ),
          ),
        );
        expect(find.byType(BackdropFilter), findsNothing,
            reason: '${entry.key} degraded to the solid fill');
        // The tint wash drops with the glass fill (the @supports rule
        // replaces the whole background).
        final tint = _design.colorOf(
            entry.key == 'banner' ? 'warning' : 'destructive');
        expect(
          tester.widgetList<ColoredBox>(
            find.byWidgetPredicate(
              (widget) => widget is ColoredBox && widget.color == _wash(tint!),
            ),
          ),
          isEmpty,
          reason: '${entry.key} dropped the tint wash in degraded mode',
        );
      }
      await shot(tester, 'glass-degraded-light.png');
    },
  );

  testWidgets('the blur is visible: the glass and degraded renders differ', (
    tester,
  ) async {
    if (!goldens) return;
    final glass = File('$_goldenDir/glass-card-light.png');
    final degraded = File('$_goldenDir/glass-degraded-light.png');
    if (!glass.existsSync() || !degraded.existsSync()) return;
    expect(
      glass.readAsBytesSync(),
      isNot(degraded.readAsBytesSync()),
      reason: 'the glass golden must visibly differ from the flat fill',
    );
  });
}
