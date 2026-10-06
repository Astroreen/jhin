import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T113 tests: the empty-fixture empty states of the decorative `usage` and
/// `pull-requests` screens (plan section 4.2, section 4.8).
///
/// The server builders (`UsageScreen`, `PullRequestsScreen`) emit a hero
/// column when the fixture has no rows; this suite proves the client renders
/// that hero rather than a blank screen. The `--fail` run inverts the
/// expectation through `T113_FAIL_MODE`.
const bool _failMode = bool.fromEnvironment('T113_FAIL_MODE');

final JhinTheme _design = JhinTheme.from();

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

/// The `usage` empty state the builder emits when the fixture has no rows.
Map<String, dynamic> _usageEmpty() => {
      'type': 'column',
      'id': 'usage-empty',
      'align': 'center',
      'gap': 8,
      'padding': 32,
      'children': [
        {
          'type': 'icon',
          'icon': 'bar_chart',
          'size': 40,
          'color': r'$color.muted-foreground',
        },
        {'type': 'text', 'text': 'No usage yet', 'style': 'h3'},
        {
          'type': 'text',
          'text': 'Connect a provider to see token usage and limits.',
          'style': 'caption',
        },
      ],
    };

/// The `pull-requests` empty state the builder emits when the fixture has no
/// rows.
Map<String, dynamic> _pullRequestsEmpty() => {
      'type': 'column',
      'id': 'pull-requests-empty',
      'align': 'center',
      'gap': 8,
      'padding': 32,
      'children': [
        {
          'type': 'icon',
          'icon': 'call_merge',
          'size': 40,
          'color': r'$color.muted-foreground',
        },
        {'type': 'text', 'text': 'No pull requests', 'style': 'h3'},
        {
          'type': 'text',
          'text': 'Pull requests from every project in this workspace appear here.',
          'style': 'caption',
        },
      ],
    };

Future<void> _pump(WidgetTester tester, Map<String, dynamic> node) async {
  tester.view.physicalSize = const Size(560, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: _design.light,
      darkTheme: _design.dark,
      themeMode: ThemeMode.light,
      home: JhinDesignScope(
        design: _design,
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
  );
  await tester.pump();
}

void main() {
  testWidgets('an empty usage fixture renders the empty state, not a blank screen',
      (tester) async {
    await _pump(tester, _usageEmpty());
    if (_failMode) {
      // The deliberately wrong expectation: the empty fixture renders a
      // blank screen (no empty-state hero).
      expect(find.text('No usage yet'), findsNothing);
    } else {
      expect(find.text('No usage yet'), findsOneWidget);
      expect(find.text('Connect a provider to see token usage and limits.'),
          findsOneWidget);
    }
  });

  testWidgets(
      'an empty pull-requests fixture renders the empty state, not a blank screen',
      (tester) async {
    await _pump(tester, _pullRequestsEmpty());
    if (_failMode) {
      // The deliberately wrong expectation: the empty fixture renders a
      // blank screen (no empty-state hero).
      expect(find.text('No pull requests'), findsNothing);
    } else {
      expect(find.text('No pull requests'), findsOneWidget);
      expect(
          find.text(
              'Pull requests from every project in this workspace appear here.'),
          findsOneWidget);
    }
  });
}
