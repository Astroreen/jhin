import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T107 tests: the Diff / Files / Preview panel tabs — the decorative
/// surfaces seeded from the fixture pack (plan section 4.8).
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the file-list
/// header with the copy-path button (`components/DiffFilePathCopyButton.tsx:14-44`),
/// the unified/split toggle (`components/DiffPanel.tsx:885-903`, `:1146`),
/// the changed-files tree with the A/M/D badges and the `+n −m` stats
/// (`components/chat/ChangedFilesTree.tsx:171-247`) and the file preview's
/// `Open in…` picker (`components/chat/OpenInPicker.tsx:357`, mounted at
/// `components/files/FilePreviewPanel.tsx:1121-1130`).
///
/// The pixel goldens land in `String.fromEnvironment('T107_GOLDEN_DIR')`
/// (absolute path) when the QA harness provides it: the three tabs in light.
/// The QA writes them with `flutter test --update-goldens` and re-runs
/// without the flag to prove the frames are byte-stable.
const String _goldenDir = String.fromEnvironment('T107_GOLDEN_DIR');

/// The deliberately wrong expectation of the `--fail` run: an empty fixture
/// is expected to render a blank tab (it renders the empty-state card).
const bool _failMode = bool.fromEnvironment('T107_FAIL_MODE');

final JhinTheme _design = JhinTheme.from();

final GlobalKey _shot = GlobalKey();

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

/// The Diff tab node the builder emits: the file-list header over the first
/// fixture file's `diff_view`.
Map<String, dynamic> _diffTab() => {
      'type': 'column',
      'id': 'right-panel-diff',
      'gap': 8,
      'padding': 12,
      'children': [
        {
          'type': 'row',
          'id': 'right-panel-diff-header',
          'align': 'center',
          'gap': 8,
          'children': [
            {'type': 'text', 'text': '3 changed files', 'fontSize': 12, 'fontWeight': 600},
            {'type': 'text', 'text': '+17', 'fontSize': 12, 'color': r'$color.diff-addition-foreground'},
            {'type': 'text', 'text': '-10', 'fontSize': 12, 'color': r'$color.diff-deletion-foreground'},
            {'type': 'spacer'},
            {
              'type': 'icon_button',
              'id': 'right-panel-diff-copy',
              'icon': 'content_copy',
              'iconSize': 16,
              'tooltip': 'Copy path',
              'demo': true,
              'action': {
                'client': [
                  {'op': 'toast', 'text': 'Copied path (preview only)'},
                ],
              },
            },
            {
              'type': 'icon_button',
              'id': 'right-panel-diff-view-toggle-unified',
              'icon': 'table_rows',
              'iconSize': 16,
              'tooltip': 'Unified view',
              'demo': true,
              'action': {
                'client': [
                  {'op': 'setState', 'id': 'chat_diff_view', 'value': 'unified'},
                  {
                    'op': 'patch',
                    'id': 'right-panel-diff-view',
                    'props': {'view': 'unified'},
                  },
                ],
              },
            },
            {
              'type': 'icon_button',
              'id': 'right-panel-diff-view-toggle-split',
              'icon': 'view_column',
              'iconSize': 16,
              'tooltip': 'Split view',
              'demo': true,
              'action': {
                'client': [
                  {'op': 'setState', 'id': 'chat_diff_view', 'value': 'split'},
                  {
                    'op': 'patch',
                    'id': 'right-panel-diff-view',
                    'props': {'view': 'split'},
                  },
                ],
              },
            },
          ],
        },
        _diffView(),
      ],
    };

Map<String, dynamic> _diffView() => {
      'type': 'diff_view',
      'id': 'right-panel-diff-view',
      'file': 'lib/agent/run.ts',
      'language': 'typescript',
      'demo': true,
      'stats': {'additions': 5, 'deletions': 2},
      'hunks': [
        {
          'header': '@@ -12,7 +12,9 @@ run loop',
          'lines': [
            {'kind': 'ctx', 'oldNo': 12, 'newNo': 12, 'text': 'for (final turn of turns) {'},
            {'kind': 'del', 'oldNo': 13, 'text': '  await runOne(turn);'},
            {'kind': 'add', 'newNo': 13, 'text': '  await runOne(turn, options);'},
            {'kind': 'add', 'newNo': 14, 'text': '  await report(turn);'},
            {'kind': 'ctx', 'oldNo': 14, 'newNo': 15, 'text': '}'},
          ],
        },
        {
          'header': '@@ -31,6 +33,8 @@ teardown',
          'lines': [
            {'kind': 'meta', 'text': '// hunk header context only'},
            {'kind': 'ctx', 'oldNo': 31, 'newNo': 33, 'text': '  cleanup();'},
            {'kind': 'add', 'newNo': 34, 'text': '  cleanup.sync();'},
            {'kind': 'add', 'newNo': 35, 'text': '  cleanup.flush();'},
          ],
        },
        {
          'header': '@@ -58,4 +62,6 @@ exports',
          'lines': [
            {'kind': 'del', 'oldNo': 58, 'text': 'export { run };'},
            {'kind': 'add', 'newNo': 62, 'text': 'export { run, runOne };'},
            {'kind': 'ctx', 'oldNo': 59, 'newNo': 63, 'text': '// end of file'},
          ],
        },
      ],
    };

/// The Files tab node the builder emits: the changed-files tree with the
/// A/M/D badges and the `+n −m` stats.
Map<String, dynamic> _filesTab() => {
      'type': 'column',
      'id': 'right-panel-files',
      'gap': 8,
      'padding': 12,
      'children': [
        {'type': 'text', 'text': 'Changed files', 'fontSize': 12, 'fontWeight': 600},
        {
          'type': 'tree',
          'id': 'right-panel-files-tree',
          'items': [
            {
              'label': 'lib',
              'icon': 'folder',
              'expanded': true,
              'items': [
                {
                  'label': 'agent',
                  'icon': 'folder',
                  'expanded': true,
                  'items': [
                    _fileLeaf('run.ts', 'lib/agent/run.ts', 'M', 5, 2),
                    _fileLeaf('prompt.ts', 'lib/agent/prompt.ts', 'A', 12, 0),
                    _fileLeaf('legacy.ts', 'lib/agent/legacy.ts', 'D', 0, 8),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

Map<String, dynamic> _fileLeaf(
  String label,
  String path,
  String status,
  int additions,
  int deletions,
) =>
    {
      'label': label,
      'path': path,
      'icon': 'description',
      'stat': '+$additions \u2212$deletions',
      'badge': {'type': 'badge', 'label': status},
      'action': {
        'client': [
          {'op': 'setState', 'id': 'chat_diff_file', 'value': path},
          {
            'op': 'patch',
            'id': 'right-panel-diff-view',
            'props': {
              'file': path,
              'language': 'typescript',
              'stats': {'additions': additions, 'deletions': deletions},
              'hunks': [
                {
                  'header': '@@ -1,1 +1,1 @@',
                  'lines': [
                    {'kind': 'ctx', 'oldNo': 1, 'newNo': 1, 'text': '// $label'},
                  ],
                },
              ],
            },
          },
        ],
      },
    };

/// The Preview tab node the builder emits: the path header with the
/// decorative `Open in…` button over the syntax-highlighted code block.
Map<String, dynamic> _previewTab() => {
      'type': 'column',
      'id': 'right-panel-preview',
      'gap': 8,
      'padding': 12,
      'children': [
        {
          'type': 'row',
          'id': 'right-panel-preview-header',
          'align': 'center',
          'gap': 8,
          'children': [
            {
              'type': 'text',
              'text': 'lib/agent/run.ts',
              'fontSize': 12,
              'fontWeight': 600,
              'maxLines': 1,
              'ellipsis': true,
              'flex': 1,
            },
            {
              'type': 'button',
              'id': 'right-panel-preview-open',
              'label': 'Open in\u2026',
              'icon': 'open_in_new',
              'style': 'text',
              'demo': true,
              'action': {
                'client': [
                  {'op': 'toast', 'text': 'Open in editor (preview only)'},
                ],
              },
            },
          ],
        },
        {
          'type': 'code_block',
          'id': 'right-panel-preview-code',
          'language': 'typescript',
          'copyable': true,
          'lineNumbers': true,
          'syntax': true,
          'code': 'export async function run(turns, options) {\n'
              '  for (final turn of turns) {\n'
              '    await runOne(turn, options);\n'
              '  }\n'
              '}\n',
        },
      ],
    };

/// The empty-state card the builder emits when the fixture has no files.
Map<String, dynamic> _emptyCard() => {
      'type': 'card',
      'id': 'right-panel-diff-empty',
      'children': [
        {
          'type': 'column',
          'gap': 4,
          'children': [
            {'type': 'text', 'text': 'No changes yet.', 'fontSize': 13, 'fontWeight': 600},
            {
              'type': 'text',
              'text': 'This build has no diff engine.',
              'fontSize': 12,
              'color': r'$color.sidebar-muted-foreground',
            },
          ],
        },
      ],
    };

Future<void> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  RenderContext? ctx,
  JhinTheme? design,
  Size size = const Size(560, 900),
}) async {
  final d = design ?? _design;
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _shot,
      child: MaterialApp(
        theme: d.light,
        darkTheme: d.dark,
        themeMode: ThemeMode.light,
        home: JhinDesignScope(
          design: d,
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
      find.byKey(_shot), matchesGoldenFile(Uri.file('$_goldenDir/$name')));
}

void main() {
  testWidgets('the diff tab renders the file-list header and the diff view',
      (tester) async {
    await _pump(tester, _diffTab());
    expect(find.text('3 changed files'), findsOneWidget);
    expect(find.text('+17'), findsOneWidget);
    expect(find.text('-10'), findsOneWidget);
    expect(find.byTooltip('Copy path'), findsOneWidget);
    // The outer header toggle and the diff_view's own toggle both carry the
    // layout tooltips; the outer one is first in the tree.
    expect(find.byTooltip('Unified view'), findsNWidgets(2));
    expect(find.byTooltip('Split view'), findsNWidgets(2));
    // The diff_view body: the file header and the three hunk headers.
    expect(find.text('lib/agent/run.ts  ·  typescript'), findsOneWidget);
    expect(find.text('@@ -12,7 +12,9 @@ run loop'), findsOneWidget);
    expect(find.text('@@ -31,6 +33,8 @@ teardown'), findsOneWidget);
    expect(find.text('@@ -58,4 +62,6 @@ exports'), findsOneWidget);
    await _golden(tester, 'diff-panel-diff-light.png');
  });

  testWidgets('the view toggle dispatches the setState + patch composite '
      'client-side — no server round-trip', (tester) async {
    final dispatched = <Map<String, dynamic>>[];
    await _pump(
      tester,
      _diffTab(),
      ctx: _ctx(UiState(), dispatched: dispatched),
    );

    // The outer header toggle is the first "Split view" tooltip.
    await tester.tap(find.byTooltip('Split view').first);
    await tester.pump();

    expect(dispatched, hasLength(1));
    final ops = dispatched.single['client'] as List;
    expect(ops, hasLength(2));
    expect(ops[0], containsPair('op', 'setState'));
    expect(ops[0], containsPair('id', 'chat_diff_view'));
    expect(ops[0], containsPair('value', 'split'));
    expect(ops[1], containsPair('op', 'patch'));
    expect(ops[1], containsPair('id', 'right-panel-diff-view'));
    expect((ops[1]['props'] as Map)['view'], 'split');
  });

  testWidgets('the diff_view follows the ambient blue-orange switch (T86)',
      (tester) async {
    final design = JhinTheme.from(prefs: {'diffColorScheme': 'blue-orange'});
    await _pump(tester, _diffTab(), design: design);
    final context = tester.element(find.text('+17'));
    final codeBg = design.colorOf('code') ??
        JhinDesignScope.materialOf(context).colorScheme.surfaceContainerHighest;
    final lanes = resolveDiffColors(
      scheme: JhinDiffColorScheme.blueOrange,
      themeAdded: kDiffAdditionFallback,
      themeRemoved: kDiffDeletionFallback,
      dark: false,
    );
    // The addition lane background is the blue mix (the ambient switch
    // applied without a colorScheme prop on the diff_view).
    expect(
      tester.widgetList<ColoredBox>(
        find.byWidgetPredicate((widget) =>
            widget is ColoredBox &&
            widget.color == Color.lerp(codeBg, lanes.added, 0.5)),
      ),
      isNotEmpty,
      reason: 'the ambient blue-orange switch applied to the T107 diff_view',
    );
  });

  testWidgets('the files tab renders the changed-files tree with badges and '
      'stats', (tester) async {
    await _pump(tester, _filesTab());
    expect(find.text('Changed files'), findsOneWidget);
    expect(find.text('lib'), findsOneWidget);
    expect(find.text('agent'), findsOneWidget);
    expect(find.text('run.ts'), findsOneWidget);
    expect(find.text('prompt.ts'), findsOneWidget);
    expect(find.text('legacy.ts'), findsOneWidget);
    // The line stats and the A/M/D badges.
    expect(find.text('+5 \u22122'), findsOneWidget);
    expect(find.text('+12 \u22120'), findsOneWidget);
    expect(find.text('+0 \u22128'), findsOneWidget);
    expect(find.text('M'), findsOneWidget);
    expect(find.text('A'), findsOneWidget);
    expect(find.text('D'), findsOneWidget);
    await _golden(tester, 'diff-panel-files-light.png');
  });

  testWidgets('tapping a file row selects it and patches the diff view',
      (tester) async {
    final patches = <String, Map<String, dynamic>>{};
    final dispatched = <Map<String, dynamic>>[];
    await _pump(
      tester,
      _filesTab(),
      ctx: _ctx(UiState(), patches: patches, dispatched: dispatched),
    );

    await tester.tap(find.text('prompt.ts'));
    await tester.pump();

    expect(dispatched, hasLength(1));
    final action = dispatched.single;
    final ops = action['client'] as List;
    expect(ops, hasLength(2));
    expect(ops[0], containsPair('op', 'setState'));
    expect(ops[0], containsPair('id', 'chat_diff_file'));
    expect(ops[0], containsPair('value', 'lib/agent/prompt.ts'));
    expect(ops[1], containsPair('op', 'patch'));
    expect(ops[1], containsPair('id', 'right-panel-diff-view'));
    expect((ops[1]['props'] as Map)['file'], 'lib/agent/prompt.ts');
  });

  testWidgets('the preview tab renders the code block and the open-in button',
      (tester) async {
    await _pump(tester, _previewTab());
    expect(find.text('lib/agent/run.ts'), findsOneWidget);
    expect(find.text('Open in\u2026'), findsOneWidget);
    expect(find.textContaining('export async function run'), findsOneWidget);
    await _golden(tester, 'diff-panel-preview-light.png');
  });

  testWidgets('an empty fixture renders the empty-state card, not a blank tab',
      (tester) async {
    await _pump(tester, _emptyCard());
    if (_failMode) {
      // The deliberately wrong expectation: the empty fixture renders a
      // blank tab (no empty-state card).
      expect(find.text('No changes yet.'), findsNothing);
    } else {
      expect(find.text('No changes yet.'), findsOneWidget);
      expect(find.text('This build has no diff engine.'), findsOneWidget);
    }
  });
}
