import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T95 tests: the shell chrome — the 52 px top bar (wordmark, breadcrumb,
/// control cluster) with the workspace gutters and the safe-area insets, the
/// page header row, the terminal drawer with its 40% narrow cap, the
/// stage-art backdrop behind the sidebar, the `motion.panel` + `easeDrawer`
/// open/close animation and the 768 px responsive rule (compact topbar,
/// drawer overlay with backdrop, hidden right panel, 0.5rem gutters).
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the top bar
/// geometry `WorkspacePageHeader.tsx:17-26` (`--workspace-topbar-height`
/// 52, `index.css:120`), the gutters (`index.css:134-140`, 0.75rem → 1.25rem
/// at sm, plus the `pl-safe`/`pr-safe` utilities at `index.css:1037-1042`),
/// the breadcrumb (`WorkspaceBreadcrumb.tsx:11-21`), the brand mark
/// (`SidebarChrome.tsx:125-140`) and the stage backdrop
/// (`SidebarStageBackdrop.tsx:50-59`, the `--stage-art-*` tokens of
/// `index.css:633-643` under the `--sidebar-stage-fade` mask).
///
/// The rendered chrome is proven by the pixel goldens (the QA harness writes
/// them with `T95_GOLDEN_DIR` and re-runs them byte-stable, the T92
/// precedent — direct `toByteData` readback hangs on this host's
/// software-rendered flutter_tester).
const String _goldenDir = String.fromEnvironment('T95_GOLDEN_DIR');

/// The t3-chat light stage-art hex set (the ThemeCatalog conversion, pinned
/// JVM-side by ThemeCatalogTest.stageArtHexPinsTheT3ChatLightConversion).
const Map<String, dynamic> _stageArt = {
  'stage-art-top': '#f28ac1',
  'stage-art-mid': '#cb3e86',
  'stage-art-bottom': '#73194f',
  'stage-art-highlight': '#ffe6f6',
  'stage-art-line': '#ffe7f8',
};

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

Map<String, dynamic> _topbar() => {
      'type': 'row',
      'id': 'chrome-topbar',
      'align': 'center',
      'children': [
        {'type': 'text', 'text': 'Jhin', 'style': 'h3'},
        {'type': 'text', 'text': 'Workspace', 'style': 'small'},
        {'type': 'text', 'text': '/', 'style': 'small'},
        {'type': 'text', 'text': 'Threads'},
        {'type': 'spacer'},
        {'type': 'text', 'text': 'controls'},
      ],
    };

Map<String, dynamic> _topbarCompact() => {
      'type': 'row',
      'id': 'chrome-topbar-compact',
      'align': 'center',
      'children': [
        {'type': 'text', 'text': 'Jhin', 'style': 'h3'},
        {'type': 'text', 'text': 'Threads'},
        {'type': 'spacer'},
      ],
    };

Map<String, dynamic> _pageHeader() => {
      'type': 'row',
      'id': 'chrome-page-header',
      'align': 'center',
      'children': [
        {'type': 'text', 'text': 'Threads', 'style': 'h3'},
        {'type': 'spacer'},
        {
          'type': 'button',
          'label': 'Arrange threads',
          'style': 'secondary',
        },
      ],
    };

Map<String, dynamic> _chromeShell({bool withDetail = true}) => {
      'type': 'shell',
      'id': 'chrome-shell',
      'breakpoint': 768,
      'stageBackdrop': true,
      'collapsible': true,
      'topbar': _topbar(),
      'topbarCompact': _topbarCompact(),
      'pageHeader': _pageHeader(),
      'sidebar': {
        'type': 'nav',
        'kind': 'sidebar',
        'items': [
          {'label': 'Pinned', 'screen': 'sessions'},
          {'label': 'Active', 'screen': 'sessions'},
        ],
      },
      if (withDetail)
        'detail': {'type': 'text', 'text': 'right panel'},
      'body': {'type': 'text', 'text': 'shell body'},
      'terminal': {
        'type': 'box',
        'height': 600,
        'child': {'type': 'text', 'text': 'terminal'},
      },
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  JhinTheme? design,
  ThemeMode mode = ThemeMode.light,
  required Size size,
  EdgeInsets safeArea = EdgeInsets.zero,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final harnessDesign = design ?? JhinTheme.from(stageArt: _stageArt);
  await tester.pumpWidget(MaterialApp(
    theme: harnessDesign.light,
    darkTheme: harnessDesign.dark,
    themeMode: mode,
    home: MediaQuery(
      // The size must ride along: a bare MediaQueryData defaults to
      // Size.zero and would flip the shell into its narrow rule.
      data: MediaQueryData(size: size, padding: safeArea),
      child: Scaffold(
        body: JhinDesignScope(
          design: harnessDesign,
          child: Material(
            child: Builder(
              builder: (context) =>
                  _ctx(UiState()).build(context, UiNode.fromJson(node)),
            ),
          ),
        ),
      ),
    ),
  ));
  await tester.pump();
}

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  group('T95 — the wide chrome', () {
    testWidgets('the top bar renders at the 52 px token height with the '
        'wordmark, the breadcrumb and the control cluster', (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(1200, 800));
      expect(find.byWidgetPredicate(
          (w) => w is SizedBox && w.height == 52), findsOneWidget);
      expect(find.text('Jhin'), findsOneWidget);
      expect(find.text('Workspace'), findsOneWidget);
      expect(find.text('/'), findsOneWidget);
      expect(find.text('Threads'), findsWidgets);
      expect(find.text('controls'), findsOneWidget);
    });

    testWidgets('the wide gutters are the sm step of workspaceGutter '
        '(1.25rem = 20 px at the 16 px interface)', (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(1200, 800));
      // The top bar and the page header row both carry the gutter padding.
      expect(
        find.byWidgetPredicate((w) =>
            w is Padding &&
            w.padding == const EdgeInsets.only(left: 20, right: 20)),
        findsNWidgets(2),
      );
    });

    testWidgets('the safe-area insets join the gutters (pl-safe/pr-safe)',
        (tester) async {
      await _pump(
        tester,
        _chromeShell(),
        size: const Size(1200, 800),
        safeArea: const EdgeInsets.only(left: 24, right: 12),
      );
      expect(
        find.byWidgetPredicate((w) =>
            w is Padding &&
            w.padding == const EdgeInsets.only(left: 44, right: 32)),
        findsNWidgets(2),
      );
    });

    testWidgets('the page header row carries the title and the actions',
        (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(1200, 800));
      expect(find.text('Arrange threads'), findsOneWidget);
      expect(find.text('right panel'), findsOneWidget);
      expect(find.text('terminal'), findsOneWidget);
    });

    testWidgets('the stage backdrop paints behind the sidebar (the golden '
        'carries the visual proof)', (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(1200, 800));
      // The sidebar nav renders over the backdrop stack.
      expect(find.text('Pinned'), findsOneWidget);
      expect(find.text('Active'), findsOneWidget);
    });

    testWidgets('the terminal drawer honours the node height wide',
        (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(1200, 800));
      // The drawer SizedBox carries the node height (the universal surface
      // wraps the box in a ConstrainedBox, not a SizedBox).
      expect(
        find.byWidgetPredicate(
            (w) => w is SizedBox && w.height == 600),
        findsOneWidget,
      );
    });
  });

  group('T95 — the narrow rule (below 768 px)', () {
    testWidgets('the compact topbar replaces the full breadcrumb',
        (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(700, 800));
      expect(find.text('Workspace'), findsNothing);
      expect(find.text('Threads'), findsWidgets);
    });

    testWidgets('the gutters compress to 0.5rem (8 px at the 16 px interface)',
        (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(700, 800));
      expect(
        find.byWidgetPredicate((w) =>
            w is Padding &&
            w.padding == const EdgeInsets.only(left: 8, right: 8)),
        findsOneWidget,
      );
    });

    testWidgets('the right panel is hidden by default', (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(700, 800));
      expect(find.text('right panel'), findsNothing);
    });

    testWidgets('the terminal drawer caps at 40% of the viewport height',
        (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(700, 800));
      // min(600, 0.4 * 800) = 320.
      expect(
        find.byWidgetPredicate(
            (w) => w is SizedBox && w.height == 320),
        findsOneWidget,
      );
    });

    testWidgets('the sidebar overlays as a drawer: the hamburger opens it, '
        'the backdrop tap closes it', (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(700, 800));
      // Closed: the panel is mounted (the closing animation needs it) but
      // parked off the leading edge.
      expect(tester.getTopLeft(find.text('Pinned')).dx, lessThanOrEqualTo(0));
      await tester.tap(find.byIcon(Icons.menu));
      await tester.pumpAndSettle();
      // Open: the panel sits at the leading edge (the nav's own content
      // padding puts the row a few px in).
      final openDx = tester.getTopLeft(find.text('Pinned')).dx;
      expect(openDx, greaterThanOrEqualTo(0));
      expect(openDx, lessThan(100));
      // The backdrop: tap it and the drawer closes.
      await tester.tapAt(const Offset(650, 400));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(find.text('Pinned')).dx, lessThanOrEqualTo(0));
    });

    testWidgets('a swipe left on the open drawer closes it', (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(700, 800));
      await tester.tap(find.byIcon(Icons.menu));
      await tester.pumpAndSettle();
      await tester.drag(find.text('Pinned'), const Offset(-300, 0));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(find.text('Pinned')).dx, lessThanOrEqualTo(0));
    });
  });

  group('T95 — motion.panel drives the sidebar open/close', () {
    testWidgets('the collapse toggle animates the width over motion.panel',
        (tester) async {
      final design = JhinTheme.from(
        stageArt: _stageArt,
        tokens: {
          'motion': {'panel': 200},
        },
      );
      await _pump(
        tester,
        _chromeShell(),
        size: const Size(1200, 800),
        design: design,
      );
      expect(find.byType(AnimatedContainer), findsOneWidget);
      await tester.tap(find.byIcon(Icons.chevron_left));
      // One pump lands the target change and starts the controller; the
      // next samples the mid-flight frame.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // Mid-animation: the pane is between 280 and the 56 collapsed width.
      final width = tester.renderObject<RenderBox>(
        find.byType(AnimatedContainer),
      ).size.width;
      expect(width, greaterThan(56));
      expect(width, lessThan(280));
      await tester.pumpAndSettle();
      expect(
        tester.renderObject<RenderBox>(find.byType(AnimatedContainer))
            .size.width,
        56,
      );
    });

    testWidgets('reduced motion collapses the animation to 0 (no '
        'AnimatedContainer)', (tester) async {
      final design = JhinTheme.from(
        stageArt: _stageArt,
        tokens: {
          'motion': {'panel': 200},
        },
        prefs: const {'reducedMotion': true},
      );
      await _pump(
        tester,
        _chromeShell(),
        size: const Size(1200, 800),
        design: design,
      );
      expect(find.byType(AnimatedContainer), findsNothing);
      await tester.tap(find.byIcon(Icons.chevron_left));
      await tester.pump();
      expect(
        find.byWidgetPredicate(
            (w) => w is SizedBox && w.width == 56),
        findsOneWidget,
      );
    });
  });

  group('T95 — goldens', () {
    testWidgets('golden: the chrome wide (light)', (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(1200, 800));
      if (goldens) {
        await expectLater(find.byType(MaterialApp),
            matchesGoldenFile(golden('shell-chrome-wide-light.png')));
      }
    });

    testWidgets('golden: the chrome wide (dark)', (tester) async {
      await _pump(
        tester,
        _chromeShell(),
        size: const Size(1200, 800),
        mode: ThemeMode.dark,
      );
      if (goldens) {
        await expectLater(find.byType(MaterialApp),
            matchesGoldenFile(golden('shell-chrome-wide-dark.png')));
      }
    });

    testWidgets('golden: the narrow viewport (the responsive rule)',
        (tester) async {
      await _pump(tester, _chromeShell(), size: const Size(700, 800));
      if (goldens) {
        await expectLater(find.byType(MaterialApp),
            matchesGoldenFile(golden('shell-chrome-narrow.png')));
      }
    });

    testWidgets('golden: the notched viewport (the safe-area insets)',
        (tester) async {
      await _pump(
        tester,
        _chromeShell(),
        size: const Size(1200, 800),
        safeArea: const EdgeInsets.only(left: 24, right: 12, top: 8),
      );
      if (goldens) {
        await expectLater(find.byType(MaterialApp),
            matchesGoldenFile(golden('shell-chrome-notched.png')));
      }
    });
  });

  test('the golden frames exist on disk once written', () {
    if (!goldens) return;
    for (final frame in [
      'shell-chrome-wide-light.png',
      'shell-chrome-wide-dark.png',
      'shell-chrome-narrow.png',
      'shell-chrome-notched.png',
    ]) {
      expect(File('$_goldenDir/$frame').existsSync(), isTrue,
          reason: '$frame is missing from the golden dir');
    }
  });
}
