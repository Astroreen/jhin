import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T90 tests: the `split` primitive — the persisted resizable two-pane
/// layout with the real upstream metrics (default 256, min 208, main-min
/// 640; storage key `chat_thread_sidebar_width`).
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb):
/// `components/threadSidebarWidth.ts:1-4` (key + 16×16 / 13×16 / 40×16
/// numbers), `hooks/useResizableWidth.ts:40-44` + `:92-99` (persist at drag
/// end only), `components/ui/sidebar.tsx:352-354` (the clamp) and
/// `components/preview/RightPanelResizeHandle.tsx:16-33` (the handle line).
/// Upstream has no keyboard resize — the 16 px arrow-key steps come from the
/// T90 spec.
///
/// The pixel goldens land in `String.fromEnvironment('T90_GOLDEN_DIR')`
/// (absolute path) when the QA harness provides it: the split with the rail
/// handle visible (hovered) in light and dark. The QA writes them with
/// `flutter test --update-goldens` and re-runs without the flag to verify.
const String _goldenDir = String.fromEnvironment('T90_GOLDEN_DIR');

/// The design under test: the fallback theme (layout.sidebarWidth 256,
/// sidebarMinWidth 208, mainMinWidth 640 — the split's defaults).
final JhinTheme _design = JhinTheme.from();

final GlobalKey _shot = GlobalKey();

/// In-memory stand-in for the client store (`persistKey` values).
class _Store {
  final Map<String, Object?> values = {};
}

RenderContext _ctx(UiState state, _Store? store) => RenderContext(
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
      readPersisted: store == null ? null : (key) async => store.values[key],
      writePersisted: store == null
          ? null
          : (key, value) async {
              store.values[key] = value;
            },
    );

Map<String, dynamic> _split([Map<String, dynamic>? overrides]) => {
      'type': 'split',
      'id': 'probe-split',
      'first': {
        'type': 'text',
        'text': 'Sidebar pane',
      },
      'second': {
        'type': 'text',
        'text': 'Main pane',
      },
      'axis': 'horizontal',
      'initial': 256,
      'min': 208,
      'max': 640,
      'minSecond': 640,
      'persistKey': 'chat_thread_sidebar_width',
      'handleStyle': 'rail',
      ...?overrides,
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  _Store? store,
  JhinTheme? design,
  ThemeMode mode = ThemeMode.light,
  Key? bodyKey,
}) async {
  final d = design ?? _design;
  tester.view.physicalSize = const Size(1280, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: d.light,
      darkTheme: d.dark,
      themeMode: mode,
      home: JhinDesignScope(
        design: d,
        child: Scaffold(
          body: RepaintBoundary(
            key: _shot,
            child: SizedBox.expand(
              key: bodyKey,
              // The capture background rides INSIDE the boundary — the
              // scaffold paints behind it, so the raster alone would carry
              // transparent canvas.
              child: ColoredBox(
                color: mode == ThemeMode.dark
                    ? d.dark.scaffoldBackgroundColor
                    : d.light.scaffoldBackgroundColor,
                child: Builder(
                  builder: (context) => _ctx(UiState(), store)
                      .build(context, UiNode.fromJson(node)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

/// Flushes the fire-and-forget persistence futures (fake-async timers).
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 5));
}

/// The handle: the `Resize divider` Semantics the primitive wraps its drag
/// surface in (other harness widgets also host gesture detectors).
final Finder _handleSemantics = find.byWidgetPredicate(
    (widget) =>
        widget is Semantics && widget.properties.label == 'Resize divider');
final Finder _handle = find.descendant(
  of: _handleSemantics,
  matching: find.byType(RawGestureDetector),
);

/// The `Focus` the primitive wraps the handle in — the keyboard surface.
final Finder _handleFocus = find.ancestor(
  of: _handle,
  matching: find.byType(Focus),
);

final Finder _firstPane = find.text('Sidebar pane');
final Finder _secondPane = find.text('Main pane');

/// Drags the handle by [dx] (horizontal) or [dy] (vertical) and flushes.
Future<void> _dragHandle(
  WidgetTester tester, {
  double dx = 0,
  double dy = 0,
}) async {
  final drag = await tester.startGesture(tester.getCenter(_handle));
  await drag.moveBy(Offset(dx, dy));
  await tester.pump();
  await drag.up();
  await tester.pump(const Duration(milliseconds: 5));
}

void main() {
  final goldens = _goldenDir.isNotEmpty;
  Uri golden(String name) => Uri.file('$_goldenDir/$name');

  Future<void> focusHandle(WidgetTester tester) async {
    // The innermost Focus ancestor of the drag surface is the primitive's
    // own keyboard surface (outer ones belong to the harness).
    tester.widget<Focus>(_handleFocus.first).focusNode?.requestFocus();
    await tester.pump();
  }

  testWidgets('dragging the handle between min and max persists the width '
      'under chat_thread_sidebar_width and restores across a remount',
      (tester) async {
    final store = _Store();
    final node = _split();
    await _pump(tester, node, store: store);
    expect(tester.getSize(_firstPane).width, 256);

    await _dragHandle(tester, dx: 200);
    expect(tester.getSize(_firstPane).width, 456);
    expect(store.values['chat_thread_sidebar_width'], 456.0);

    // A fresh mount of the same node reads the persisted width before it
    // renders — the width survives a rebuild (the plan acceptance).
    final remounted = _Store()
      ..values['chat_thread_sidebar_width'] = 456.0;
    await _pump(tester, node, store: remounted, bodyKey: const Key('remount'));
    await _settle(tester);
    expect(tester.getSize(_firstPane).width, 456);
  });

  testWidgets('the second pane can never shrink below minSecond (640)',
      (tester) async {
    final store = _Store();
    await _pump(tester, _split(), store: store);
    // Far beyond every cap: the divider stops at max(640) ∩ 1280 − 640.
    await _dragHandle(tester, dx: 800);
    expect(tester.getSize(_firstPane).width, 640);
    expect(tester.getSize(_secondPane).width, greaterThanOrEqualTo(640));
    expect(store.values['chat_thread_sidebar_width'], 640.0);
  });

  testWidgets('a drag below min clamps: the divider stays at min and the '
      'clamp is persisted', (tester) async {
    final store = _Store();
    await _pump(tester, _split(), store: store);
    await _dragHandle(tester, dx: -200);
    expect(tester.getSize(_firstPane).width, 208,
        reason: 'a drag below min snaps back to the min clamp (208)');
    expect(store.values['chat_thread_sidebar_width'], 208.0);
  });

  testWidgets('the handle resizes by 16 px arrow-key steps and persists',
      (tester) async {
    final store = _Store();
    await _pump(tester, _split(), store: store);
    await focusHandle(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await _settle(tester);
    expect(tester.getSize(_firstPane).width, 272);
    expect(store.values['chat_thread_sidebar_width'], 272.0);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await _settle(tester);
    expect(tester.getSize(_firstPane).width, 256);
    expect(store.values['chat_thread_sidebar_width'], 256.0);
  });

  testWidgets('a non-drag divider change animates over motion.panel with '
      'the easeDrawer curve', (tester) async {
    final design = JhinTheme.from(motion: {'panel': 200});
    final store = _Store();
    await _pump(tester, _split(), store: store, design: design);
    await focusHandle(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final mid = tester.getSize(_firstPane).width;
    expect(mid, greaterThan(256), reason: 'the transition is animated');
    expect(mid, lessThan(272), reason: '50 ms into a 200 ms transition');

    await tester.pumpAndSettle();
    expect(tester.getSize(_firstPane).width, 272);

    final animated = tester.widget<AnimatedContainer>(
        find.byType(AnimatedContainer));
    expect(animated.duration, const Duration(milliseconds: 200));
    final curve = animated.curve;
    expect(curve, isA<Cubic>());
    expect((curve as Cubic).a, 0.32);
    expect(curve.b, 0.72);
    expect(curve.c, 0.0);
    expect(curve.d, 1.0);
  });

  testWidgets('the vertical axis drags by dy with the same clamp rules',
      (tester) async {
    final store = _Store();
    await _pump(
      tester,
      _split({
        'axis': 'vertical',
        'minSecond': 100,
        'max': 600,
        'persistKey': 'qa_probe_split_vertical',
      }),
      store: store,
    );
    expect(tester.getSize(_firstPane).height, 256);
    await _dragHandle(tester, dy: 150);
    expect(tester.getSize(_firstPane).height, 406);
    expect(store.values['qa_probe_split_vertical'], 406.0);

    // Below the min the divider clamps (min falls back to
    // layout.sidebarMinWidth = 208).
    await _dragHandle(tester, dy: -600);
    expect(tester.getSize(_firstPane).height, 208);
  });

  testWidgets('a missing pane degrades visibly; an unknown handle style '
      'degrades to the rail', (tester) async {
    await _pump(tester, _split({
      'first': null,
      'handleStyle': 'wire',
    }));
    expect(find.text('Missing first pane'), findsOneWidget);
  });

  testWidgets('without a backing store the drag still works (memory only)',
      (tester) async {
    await _pump(tester, _split(), store: null);
    await _dragHandle(tester, dx: 100);
    expect(tester.getSize(_firstPane).width, 356);
  });

  // One test per mode: a second pumpWidget inside the same test reuses the
  // MaterialApp element and does not re-theme (the frame would stay light).
  Future<void> goldenMode(WidgetTester tester, ThemeMode mode) async {
    final label = mode == ThemeMode.light ? 'light' : 'dark';
    await _pump(
      tester,
      _split({
        'first': {
          'type': 'box',
          'children': [
            {'type': 'text', 'text': 'Sidebar pane'},
          ],
        },
      }),
      mode: mode,
    );
    // Hover the handle so the rail line reveals (the upstream
    // `hover:after:bg-sidebar-border` reveal).
    final gesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse, pointer: 40);
    final center = tester.getCenter(_handle);
    await gesture.addPointer(location: center);
    await gesture.moveTo(center);
    await tester.pump();
    if (goldens) {
      await expectLater(find.byKey(_shot),
          matchesGoldenFile(golden('split-rail-$label.png')));
    }
    await gesture.removePointer(location: center);
    await tester.pump();
  }

  testWidgets('golden: the split with the rail handle visible (light)',
      (tester) => goldenMode(tester, ThemeMode.light));
  testWidgets('golden: the split with the rail handle visible (dark)',
      (tester) => goldenMode(tester, ThemeMode.dark));
}
