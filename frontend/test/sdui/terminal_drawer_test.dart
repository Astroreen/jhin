import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T106 tests: the decorative terminal drawer — the grip resize with its
/// 100 px floor and 50% viewport cap, the `terminal_height` persistence, the
/// `Escape` close and the `mod+w` close precedence.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the drawer
/// resize strip (`components/ThreadTerminalDrawer.tsx:1434-1441`, the
/// `h-1.5 cursor-row-resize` handle) and the `mod+w` precedence
/// (`packages/shared/src/keybindings.ts:30-31`: `terminal.close` while
/// `terminalFocus`, `rightPanel.close` otherwise).
///
/// The pixel golden lands in `String.fromEnvironment('T106_GOLDEN_DIR')`
/// (absolute path) when the QA harness provides it: the open drawer in
/// light. The QA writes it with `flutter test --update-goldens` and re-runs
/// without the flag to verify.
const String _goldenDir = String.fromEnvironment('T106_GOLDEN_DIR');

/// The deliberately wrong expectation of the `--fail` run: a drag below the
/// 100 px floor is expected to drop the height below it (it does not — the
/// drag clamps at 100).
const bool _failMode = bool.fromEnvironment('T106_FAIL_MODE');

final JhinTheme _design = JhinTheme.from();

final GlobalKey _goldenKey = GlobalKey();

RenderContext _ctx(UiState state, {Map<String, Object?>? store}) =>
    RenderContext(
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
      readPersisted: store == null ? null : (key) async => store[key],
      writePersisted:
          store == null ? null : (key, value) async => store[key] = value,
    );

/// The shell carrying the T106 terminal drawer node.
Map<String, dynamic> _shell() => {
      'type': 'shell',
      'id': 'terminal-test-shell',
      'breakpoint': 768,
      'body': {
        'type': 'text',
        'text': 'shell body',
      },
      'terminal': {
        'type': 'container',
        'id': 'terminal-drawer',
        'direction': 'column',
        'when': 'chat_terminal == true',
        'initialHeight': 240,
        'minDrawerHeight': 100,
        'maxDrawerRatio': 0.5,
        'persistKey': 'terminal_height',
        'closeState': 'chat_terminal',
        'children': [
          {
            'type': 'row',
            'id': 'terminal-drawer-header',
            'align': 'center',
            'children': [
              {'type': 'icon', 'icon': 'drag_indicator', 'size': 16},
              {'type': 'text', 'text': 'Terminal'},
              {'type': 'spacer'},
              {
                'type': 'icon_button',
                'id': 'terminal-drawer-close',
                'icon': 'close',
                'iconSize': 16,
                'constraints': {'minWidth': 24, 'minHeight': 24},
              },
            ],
          },
          {
            'type': 'expanded',
            'flex': 1,
            'child': {
              'type': 'scroll',
              'items': [
                {
                  'type': 'code_block',
                  'id': 'terminal-drawer-transcript',
                  'code': r'$ jhin health' '\n' 'ok',
                  'language': 'shell',
                },
              ],
            },
          },
        ],
      },
    };

Future<void> _pump(
  WidgetTester tester,
  UiState state, {
  Map<String, Object?>? store,
  Size size = const Size(1200, 800),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _goldenKey,
      child: MaterialApp(
        theme: _design.light,
        darkTheme: _design.dark,
        themeMode: ThemeMode.light,
        home: MediaQuery(
          data: MediaQueryData(size: size),
          child: JhinDesignScope(
            design: _design,
            child: Scaffold(
              body: Builder(
                builder: (context) => _ctx(state, store: store)
                    .build(context, UiNode.fromJson(_shell())),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

double _drawerHeight(WidgetTester tester) => tester
    .widget<SizedBox>(find.byKey(const Key('terminal-drawer-surface')))
    .height!;

Future<void> _golden(WidgetTester tester, String name) async {
  if (_goldenDir.isEmpty) return;
  await expectLater(
      find.byKey(_goldenKey), matchesGoldenFile(Uri.file('$_goldenDir/$name')));
}

void main() {
  testWidgets('the drawer renders when the terminal state is on',
      (tester) async {
    final state = UiState()..setValue('chat_terminal', true);
    await _pump(tester, state);
    expect(find.byKey(const Key('terminal-drawer-surface')), findsOneWidget);
    expect(find.text('Terminal'), findsOneWidget);
    await _golden(tester, 'terminal-drawer-light.png');
  });

  testWidgets('the drawer is hidden when the terminal state is off',
      (tester) async {
    final state = UiState()..setValue('chat_terminal', false);
    await _pump(tester, state);
    expect(find.byKey(const Key('terminal-drawer-surface')), findsNothing);
    expect(find.text('Terminal'), findsNothing);
  });

  testWidgets('the grip drag clamps at the 100 px floor', (tester) async {
    final state = UiState()..setValue('chat_terminal', true);
    await _pump(tester, state);
    expect(_drawerHeight(tester), 240);
    // Drag down 300 px: 240 - 300 = -60 clamps to the 100 px floor.
    await tester.drag(
        find.byKey(const Key('terminal-drawer-grip')), const Offset(0, 300));
    await tester.pump();
    expect(_drawerHeight(tester), 100);
  });

  testWidgets('the grip drag caps at 50% of the viewport', (tester) async {
    final state = UiState()..setValue('chat_terminal', true);
    await _pump(tester, state);
    // Drag up 1000 px: 240 + 1000 caps at 0.5 * 800 = 400.
    await tester.drag(
        find.byKey(const Key('terminal-drawer-grip')), const Offset(0, -1000));
    await tester.pump();
    expect(_drawerHeight(tester), 400);
  });

  testWidgets('the drag persists the height under terminal_height',
      (tester) async {
    final state = UiState()..setValue('chat_terminal', true);
    final store = <String, Object?>{};
    await _pump(tester, state, store: store);
    await tester.drag(
        find.byKey(const Key('terminal-drawer-grip')), const Offset(0, 300));
    await tester.pump();
    // The write is fire-and-forget (a zero-duration timer); flush it.
    await tester.pump(const Duration(milliseconds: 5));
    expect(store['terminal_height'], 100);
  });

  testWidgets('Escape closes the terminal', (tester) async {
    final state = UiState()..setValue('chat_terminal', true);
    await _pump(tester, state);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(state['chat_terminal'], false);
  });

  testWidgets('mod+w closes the focused terminal first', (tester) async {
    final state = UiState()..setValue('chat_terminal', true);
    await _pump(tester, state);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyW);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pump();
    expect(state['chat_terminal'], false);
  });

  if (_failMode) {
    testWidgets('FAIL MODE: a drag below 100 px is expected NOT to clamp',
        (tester) async {
      final state = UiState()..setValue('chat_terminal', true);
      await _pump(tester, state);
      await tester.drag(
          find.byKey(const Key('terminal-drawer-grip')), const Offset(0, 300));
      await tester.pump();
      // The deliberately wrong expectation: the height drops below the floor.
      expect(_drawerHeight(tester), lessThan(100));
    });
  }
}
