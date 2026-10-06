import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T105 tests: the right-panel tab bar (`tabs` with `hasClose`) and the
/// per-tab close behaviour.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb):
/// `components/ui/panel-tab-close-button.tsx:16-27` (the `size-4` close
/// button swapping the tab identity for the `X`), `components/RightPanelTabs.tsx:1101-1214`
/// (the tab row: icon + title + close, active `bg-accent`, inactive
/// `text-muted-foreground`, `gap-1`, `pr-2 pl-1.5`) and `index.css:129`
/// (`--thread-details-panel-width: 17.5rem`).
///
/// The pixel golden lands in `String.fromEnvironment('T105_GOLDEN_DIR')`
/// (absolute path) when the QA harness provides it: the panel tab bar in
/// light. The QA writes it with `flutter test --update-goldens` and re-runs
/// without the flag to verify.
const String _goldenDir = String.fromEnvironment('T105_GOLDEN_DIR');

/// The deliberately wrong expectation of the `--fail` run: a pinned
/// (`closable: false`) tab is expected to be removed by its close button
/// (it is not — the close is a no-op).
const bool _failMode = bool.fromEnvironment('T105_FAIL_MODE');

final JhinTheme _design = JhinTheme.from();

final GlobalKey _goldenKey = GlobalKey();

RenderContext _ctx(
  UiState state, {
  Map<String, Map<String, dynamic>>? patches,
  List<Map<String, dynamic>>? dispatched,
}) =>
    RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: patches ?? {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) =>
          (patches ?? {})[id] = {...(patches ?? {})[id] ?? {}, ...props},
      navigate: (screen) {},
      dispatch: (action) async => dispatched?.add(action),
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) {},
    );

Map<String, dynamic> _tabs({
  List<Map<String, dynamic>>? items,
  bool hasClose = true,
  Map<String, dynamic>? closeAction,
}) =>
    {
      'type': 'tabs',
      'id': 'right-panel-tabs',
      'activeIndex': 0,
      'hasClose': hasClose,
      'closeAction': ?closeAction,
      'items': items ??
          [
            {'label': 'Details', 'icon': 'info', 'panel': _panel('Details panel')},
            {'label': 'Diff', 'icon': 'difference', 'panel': _panel('Diff panel')},
            {'label': 'Files', 'icon': 'folder', 'panel': _panel('Files panel')},
            {'label': 'Preview', 'icon': 'public', 'panel': _panel('Preview panel')},
            {
              'label': 'Pull Requests',
              'icon': 'call_merge',
              'panel': _panel('Pull Requests panel')
            },
            {'label': 'Usage', 'icon': 'bar_chart', 'panel': _panel('Usage panel')},
          ],
    };

Map<String, dynamic> _panel(String text) => {
      'type': 'column',
      'padding': 12,
      'children': [
        {'type': 'text', 'text': text},
      ],
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  RenderContext? ctx,
  Size size = const Size(560, 420),
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
        home: JhinDesignScope(
          design: _design,
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

Future<void> _golden(WidgetTester tester, String name) async {
  if (_goldenDir.isEmpty) return;
  await expectLater(
      find.byKey(_goldenKey), matchesGoldenFile(Uri.file('$_goldenDir/$name')));
}

void main() {
  testWidgets('the panel tab bar renders six tabs with icons and close '
      'buttons', (tester) async {
    await _pump(tester, _tabs());
    for (final label in const [
      'Details',
      'Diff',
      'Files',
      'Preview',
      'Pull Requests',
      'Usage',
    ]) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    // One close X per tab (the PanelTabCloseButton).
    expect(find.byIcon(Icons.close), findsNWidgets(6));
    // The Details panel is the active one.
    expect(find.text('Details panel'), findsOneWidget);
    await _golden(tester, 'right-panel-tabs-light.png');
  });

  testWidgets('the demo badge does not overlap the tab close X (T117)',
      (tester) async {
    // Two tabs keep the last close X on screen, where the top-right badge
    // used to cover it.
    await _pump(
      tester,
      {
        ..._tabs(items: [
          {'label': 'Details', 'icon': 'info', 'panel': _panel('Details panel')},
          {'label': 'Diff', 'icon': 'difference', 'panel': _panel('Diff panel')},
        ]),
        'demo': true,
      },
    );
    expect(find.text('preview'), findsOneWidget,
        reason: 'the shared corner badge marks the decorative tabs node');
    final badge = tester.getRect(find.text('preview'));
    final close = tester.getRect(find.byIcon(Icons.close).last);
    expect(badge.overlaps(close), isFalse,
        reason: 'the preview badge must not cover the last tab close X');
  });

  testWidgets('closing a tab removes it with a client-side patch — no server '
      'round-trip', (tester) async {
    final patches = <String, Map<String, dynamic>>{};
    final dispatched = <Map<String, dynamic>>[];
    await _pump(
      tester,
      _tabs(),
      ctx: _ctx(UiState(), patches: patches, dispatched: dispatched),
    );
    expect(find.text('Diff'), findsOneWidget);

    // The second close X belongs to the Diff tab.
    await tester.tap(find.byIcon(Icons.close).at(1));
    await tester.pump();

    expect(find.text('Diff'), findsNothing);
    expect(find.byIcon(Icons.close), findsNWidgets(5));
    // The removal rode a patch on the tabs node; nothing was dispatched for a
    // non-last close.
    expect(patches['right-panel-tabs'], contains('items'));
    expect((patches['right-panel-tabs']!['items'] as List).length, 5);
    expect(dispatched, isEmpty);
  });

  testWidgets('closing the last tab runs the node closeAction (the panel '
      'close)', (tester) async {
    final patches = <String, Map<String, dynamic>>{};
    final dispatched = <Map<String, dynamic>>[];
    final closeAction = {
      'client': [
        {'op': 'setState', 'id': 'chat_right_panel', 'value': false},
      ],
    };
    await _pump(
      tester,
      _tabs(
        hasClose: true,
        closeAction: closeAction,
        items: [
          {'label': 'Only', 'icon': 'info', 'panel': _panel('Only panel')},
        ],
      ),
      ctx: _ctx(UiState(), patches: patches, dispatched: dispatched),
    );
    expect(find.text('Only'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close));
    await tester.pump();

    expect(find.text('Only'), findsNothing);
    expect(dispatched, hasLength(1));
    expect(dispatched.single, closeAction);
  });

  testWidgets('a pinned tab (closable: false) close is a no-op', (tester) async {
    final patches = <String, Map<String, dynamic>>{};
    await _pump(
      tester,
      _tabs(
        items: [
          {
            'label': 'Details',
            'icon': 'info',
            'closable': false,
            'panel': _panel('Details panel'),
          },
          {'label': 'Diff', 'icon': 'difference', 'panel': _panel('Diff panel')},
        ],
      ),
      ctx: _ctx(UiState(), patches: patches),
    );
    expect(find.text('Details'), findsOneWidget);

    // The first close X belongs to the pinned Details tab.
    await tester.tap(find.byIcon(Icons.close).at(0));
    await tester.pump();

    if (_failMode) {
      // The deliberately wrong expectation: the pinned tab was removed.
      expect(find.text('Details'), findsNothing);
    } else {
      expect(find.text('Details'), findsOneWidget);
      expect(find.byIcon(Icons.close), findsNWidgets(2));
      // No items patch: the pinned close never removed the tab.
      expect(patches['right-panel-tabs'] ?? const {}, isNot(contains('items')));
    }
  });

  testWidgets('switching tabs keeps working with hasClose on', (tester) async {
    await _pump(tester, _tabs());
    expect(find.text('Details panel'), findsOneWidget);
    await tester.tap(find.text('Files'));
    await tester.pump();
    expect(find.text('Files panel'), findsOneWidget);
    expect(find.text('Details panel'), findsNothing);
  });

  testWidgets('the panelWidth container parses the 17.5rem token', (tester) async {
    await _pump(tester, {
      'type': 'container',
      'id': 'right-panel',
      'direction': 'column',
      'panelWidth': '17.5rem',
      'children': [
        {'type': 'text', 'text': 'Panel body'},
      ],
    });
    final width = tester
        .getSize(find
            .ancestor(
              of: find.text('Panel body'),
              matching: find.byType(Column),
            )
            .first)
        .width;
    // 17.5rem at the 16px interface base = 280.
    expect(width, 280);
  });
}
