import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/action_dispatcher.dart';
import 'package:jhin/sdui/primitives/progress.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import '../sdui_fakes.dart';

/// T108 tests: the browser-preview panel chrome and the permissions dialog
/// shell.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the preview
/// chrome row with the URL input and the refresh button
/// (`components/preview/PreviewChromeRow.tsx:114-318`), the
/// `preview-loading-progress` keyframe (`index.css:2118-2151`) and the
/// unavailable-preview copy (`components/preview/PreviewPanel.tsx:31-40`).
///
/// The pixel goldens land in `String.fromEnvironment('T108_GOLDEN_DIR')`
/// (absolute path) when the QA harness provides it. The QA writes them with
/// `flutter test --update-goldens` and re-runs without the flag to prove the
/// frames are byte-stable.
const String _goldenDir = String.fromEnvironment('T108_GOLDEN_DIR');

/// The deliberately wrong expectation of the `--fail` run: an empty URL is
/// expected to animate the progress bar (it shows the validation error).
const bool _failMode = bool.fromEnvironment('T108_FAIL_MODE');

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

/// The browser-preview section the builder emits.
Map<String, dynamic> _browserPreview({bool loading = false, String url = 'http://localhost:5173'}) => {
      'type': 'column',
      'id': 'right-panel-preview-browser',
      'gap': 8,
      'children': [
        {
          'type': 'row',
          'id': 'right-panel-preview-url-bar',
          'align': 'center',
          'gap': 8,
          'children': [
            {
              'type': 'input',
              'id': 'preview_url',
              'value': url,
              'placeholder': 'Search or enter URL',
              'readOnly': true,
              'required': true,
              'errorText': 'Enter a URL to preview',
              'flex': 1,
            },
            {
              'type': 'icon_button',
              'id': 'right-panel-preview-reload',
              'icon': 'refresh',
              'iconSize': 16,
              'tooltip': 'Reload',
              'demo': true,
              'action': {
                'path': '/ui/action/preview-reload',
                'method': 'POST',
                'name': 'preview-reload',
                'include': ['preview_url'],
              },
            },
          ],
        },
        {
          'type': 'progress',
          'id': 'right-panel-preview-progress',
          'kind': 'linear',
          'statusPulse': 'preview-loading',
          'loading': loading,
        },
        {
          'type': 'column',
          'id': 'right-panel-preview-viewport',
          'align': 'center',
          'gap': 8,
          'padding': 24,
          'children': [
            {
              'type': 'figure',
              'id': 'right-panel-preview-figure',
              'shape': 'rectangle',
              'color': r'$color.muted',
              'width': 160,
              'height': 96,
            },
            {
              'type': 'text',
              'text': 'Preview is not available in this build',
              'fontSize': 13,
              'fontWeight': 600,
            },
            {
              'type': 'text',
              'text': 'Browser previews are only available in the desktop app.',
              'fontSize': 12,
              'color': r'$color.sidebar-muted-foreground',
            },
          ],
        },
      ],
    };

/// The retained T107 file preview section.
Map<String, dynamic> _filePreview() => {
      'type': 'column',
      'id': 'right-panel-preview-file',
      'gap': 8,
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

/// The whole Preview tab the builder emits.
Map<String, dynamic> _previewTab({bool loading = false, String url = 'http://localhost:5173'}) => {
      'type': 'column',
      'id': 'right-panel-preview',
      'gap': 8,
      'padding': 12,
      'children': [
        _browserPreview(loading: loading, url: url),
        _filePreview(),
      ],
    };

/// The permissions dialog the builder emits.
Map<String, dynamic> _permissionsDialog() => {
      'type': 'column',
      'id': 'composer-mode-dialog',
      'gap': 8,
      'children': [
        {
          'type': 'row',
          'gap': 8,
          'align': 'center',
          'children': [
            {'type': 'text', 'text': 'Permissions', 'fontWeight': 600},
            {'type': 'kbd', 'chord': 'mod+shift+a'},
          ],
        },
        {
          'type': 'list',
          'id': 'permissions-modes',
          'items': [
            _permissionRow('Read only', 'read-only', true),
            _permissionRow('Ask', 'ask', false),
            _permissionRow('Full access', 'full-access', false),
          ],
        },
        {
          'type': 'text',
          'id': 'permissions-note',
          'text': 'Preview only \u2014 permission changes are not saved in this build.',
          'fontSize': 12,
          'color': r'$color.muted-foreground',
        },
        {
          'type': 'button',
          'id': 'permissions-save',
          'label': 'Save',
          'demo': true,
          'action': {
            'client': [
              {'op': 'toast', 'text': 'Permissions saved (preview only)'},
              {'op': 'dismissDialog'},
            ],
          },
        },
      ],
    };

Map<String, dynamic> _permissionRow(String mode, String slug, bool selected) => {
      'type': 'list_row',
      'id': 'permission-mode-$slug',
      'leading': {
        'type': 'icon',
        'id': 'permission-mode-$slug-radio',
        'icon': selected ? 'radio_button_checked' : 'radio_button_unchecked',
        'size': 18,
        'color': selected ? r'$color.accent' : r'$color.muted-foreground',
      },
      'title': mode,
      'subtitle': 'Permission mode $mode.',
      'selected': selected,
      'demo': true,
      'action': {
        'client': [
          {'op': 'setState', 'id': 'chat_mode', 'value': mode},
          {
            'op': 'patch',
            'id': 'permission-mode-$slug-radio',
            'props': {
              'icon': 'radio_button_checked',
              'color': r'$color.accent',
            },
          },
          {'op': 'toast', 'text': '$mode selected (preview only)'},
        ],
      },
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
  testWidgets('the preview tab renders the URL bar, the progress bar and the '
      'viewport placeholder', (tester) async {
    await _pump(tester, _previewTab());
    expect(find.text('http://localhost:5173'), findsOneWidget);
    expect(find.byTooltip('Reload'), findsOneWidget);
    expect(find.text('Preview is not available in this build'), findsOneWidget);
    expect(find.text('Browser previews are only available in the desktop app.'),
        findsOneWidget);
    // The retained file preview below the browser chrome.
    expect(find.text('lib/agent/run.ts'), findsOneWidget);
    expect(find.text('Open in\u2026'), findsOneWidget);
    await _golden(tester, 'preview-panel-browser-light.png');
  });

  testWidgets('the preview-loading bar animates from 0.04 to 0.9 and holds',
      (tester) async {
    await _pump(tester, _previewTab(loading: true));
    await tester.pump(const Duration(milliseconds: 100));
    final early = _barScale(tester);
    await tester.pump(const Duration(milliseconds: 2600));
    final mid = _barScale(tester);
    await tester.pump(const Duration(milliseconds: 3000));
    final held = _barScale(tester);
    expect(early, greaterThanOrEqualTo(kPreviewLoadingFrom));
    expect(mid, greaterThan(early));
    expect(held, closeTo(kPreviewLoadingTo, 0.001));
    await _golden(tester, 'preview-panel-loading-light.png');
  });

  testWidgets('the reload button dispatches the preview-reload action with the '
      'URL included', (tester) async {
    final dispatched = <Map<String, dynamic>>[];
    await _pump(
      tester,
      _previewTab(),
      ctx: _ctx(UiState(), dispatched: dispatched),
    );

    await tester.tap(find.byTooltip('Reload'));
    await tester.pump();

    expect(dispatched, hasLength(1));
    final action = dispatched.single;
    expect(action['path'], '/ui/action/preview-reload');
    expect(action['name'], 'preview-reload');
    expect(action['include'], ['preview_url']);
  });

  testWidgets('reload on an empty URL shows the validation error instead of '
      'animating', (tester) async {
    final transport = ScriptedTransport();
    final state = UiState();
    final root = UiNode.fromJson(_previewTab(url: ''));
    final dispatcher = ActionDispatcher(
      transport: transport,
      state: state,
      root: () => root,
      onChanged: () {},
      runDirectives: (list) async {},
    );

    final reload = root.findById('right-panel-preview-reload')!;
    await dispatcher.dispatch(
        Map<String, dynamic>.from(reload.props['action'] as Map));

    if (_failMode) {
      // The deliberately wrong expectation: the empty URL animates (it does
      // not — the dispatcher blocks and shows the inline error).
      expect(transport.calls, isNotEmpty);
    } else {
      expect(transport.calls, isEmpty);
      expect(state.errorFor('preview_url'), 'Enter a URL to preview');
    }
  });

  testWidgets('reload on a filled URL posts the action', (tester) async {
    final transport = ScriptedTransport();
    final state = UiState()..seedValue('preview_url', 'http://localhost:5173');
    final root = UiNode.fromJson(_previewTab());
    final dispatcher = ActionDispatcher(
      transport: transport,
      state: state,
      root: () => root,
      onChanged: () {},
      runDirectives: (list) async {},
    );

    final reload = root.findById('right-panel-preview-reload')!;
    await dispatcher.dispatch(
        Map<String, dynamic>.from(reload.props['action'] as Map));

    expect(transport.calls, hasLength(1));
    expect(transport.calls.single.path, '/ui/action/preview-reload');
  });

  testWidgets('the permissions dialog renders the three modes, the note and '
      'Save', (tester) async {
    await _pump(tester, _permissionsDialog());
    expect(find.text('Permissions'), findsOneWidget);
    expect(find.text('Read only'), findsOneWidget);
    expect(find.text('Ask'), findsOneWidget);
    expect(find.text('Full access'), findsOneWidget);
    expect(find.textContaining('Preview only'), findsOneWidget);
    expect(find.text('Save'), findsOneWidget);
    await _golden(tester, 'permissions-dialog-light.png');
  });

  testWidgets('a permission row flips the radio group and sets the mode',
      (tester) async {
    final dispatched = <Map<String, dynamic>>[];
    await _pump(
      tester,
      _permissionsDialog(),
      ctx: _ctx(UiState(), dispatched: dispatched),
    );

    await tester.tap(find.text('Full access'));
    await tester.pump();

    expect(dispatched, hasLength(1));
    final ops = dispatched.single['client'] as List;
    expect(ops.first, containsPair('op', 'setState'));
    expect(ops.first, containsPair('id', 'chat_mode'));
    expect(ops.first, containsPair('value', 'Full access'));
  });

  testWidgets('Save toasts and closes the dialog', (tester) async {
    final dispatched = <Map<String, dynamic>>[];
    await _pump(
      tester,
      _permissionsDialog(),
      ctx: _ctx(UiState(), dispatched: dispatched),
    );

    await tester.tap(find.text('Save'));
    await tester.pump();

    expect(dispatched, hasLength(1));
    final ops = dispatched.single['client'] as List;
    expect(ops, hasLength(2));
    expect(ops[0], containsPair('op', 'toast'));
    expect(ops[1], containsPair('op', 'dismissDialog'));
  });
}

/// The current scaleX of the preview-loading bar's [Transform].
double _barScale(WidgetTester tester) {
  final transform = tester.widget<Transform>(
    find.descendant(
      of: find.byType(Opacity),
      matching: find.byType(Transform),
    ).first,
  );
  // Transform.scale writes the x scale into storage[0]; scaleY stays 1.
  return transform.transform.storage[0];
}
