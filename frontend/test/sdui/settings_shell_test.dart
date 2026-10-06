import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T109 tests: the settings shell — the left settings `nav` (kind `sidebar`)
/// with the fourteen sub-route entries, the active-route highlight and the
/// `Settings / <name>` breadcrumb in the page header slot.
///
/// Upstream anchors (t3code `apps/web/src`, commit 37de6cb): the settings
/// route layout `routes/settings.tsx:110-140`, the nav
/// `components/settings/SettingsSidebarNav.tsx:245-266` and the breadcrumb
/// `components/settings/SettingsBreadcrumb.tsx:20-40`.
const List<List<String>> _routes = [
  ['settings:general', 'General'],
  ['settings:appearance', 'Appearance'],
  ['settings:keybindings', 'Keybindings'],
  ['settings:providers', 'Providers'],
  ['settings:connections', 'Connections'],
  ['settings:integrations', 'Integrations'],
  ['settings:diagnostics', 'Diagnostics'],
  ['settings:storage', 'Storage'],
  ['settings:archived', 'Archive'],
  ['settings:projects', 'Project'],
  ['settings:scheduled-tasks', 'Scheduled Tasks'],
  ['settings:source-control', 'Source Control'],
  ['settings:snap-shot', 'SnapShots'],
  ['settings:licenses', 'Open source licenses'],
];

Map<String, dynamic> _settingsShell({
  String activeId = 'settings:general',
  String label = 'General',
}) =>
    {
      'type': 'screen',
      'title': 'Settings',
      'body': {
        'type': 'shell',
        'id': 'settings-shell',
        'breakpoint': 768,
        'stageBackdrop': true,
        'topbar': {
          'type': 'row',
          'id': 'settings-topbar',
          'align': 'center',
          'children': [
            {'type': 'text', 'text': 'Jhin', 'style': 'h3'},
            {'type': 'spacer'},
            {
              'type': 'button',
              'label': 'Back to threads',
              'action': {'client': [{'op': 'navigate', 'screen': 'sessions'}]},
            },
          ],
        },
        'topbarCompact': {
          'type': 'row',
          'id': 'settings-topbar-compact',
          'align': 'center',
          'children': [
            {'type': 'text', 'text': 'Jhin', 'style': 'h3'},
            {'type': 'spacer'},
          ],
        },
        'pageHeader': {
          'type': 'row',
          'id': 'settings-breadcrumb',
          'align': 'center',
          'children': [
            {'type': 'text', 'text': 'Settings', 'style': 'small'},
            {'type': 'text', 'text': '/', 'style': 'small'},
            {'type': 'text', 'text': label},
          ],
        },
        'sidebar': {
          'type': 'nav',
          'id': 'settings-nav',
          'kind': 'sidebar',
          'activeId': activeId,
          'items': [
            for (final route in _routes)
              {
                'id': route[0],
                'label': route[1],
                'icon': 'settings',
                'screen': route[0],
              },
          ],
        },
        'body': {'type': 'text', 'text': 'panel'},
      },
    };

class _Harness {
  final List<String> navigated = [];

  RenderContext ctx(UiState state) => RenderContext(
        state: state,
        registry: UiRegistry.standard(),
        patches: {},
        setState: (id, value) => state.setValue(id, value),
        patch: (id, props) {},
        navigate: navigated.add,
        dispatch: (action) async {},
        openStream: (topic, {onStatus}) => const Stream.empty(),
        runDirectives: (directives) async {},
        confirm: (message, onConfirm) {},
      );
}

Future<_Harness> _pump(
  WidgetTester tester,
  Map<String, dynamic> node, {
  Size size = const Size(1200, 800),
}) async {
  final harness = _Harness();
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final design = JhinTheme.from();
  await tester.pumpWidget(MaterialApp(
    theme: design.light,
    darkTheme: design.dark,
    home: MediaQuery(
      data: MediaQueryData(size: size),
      child: Scaffold(
        body: JhinDesignScope(
          design: design,
          child: Material(
            child: Builder(
              builder: (context) =>
                  harness.ctx(UiState()).build(context, UiNode.fromJson(node)),
            ),
          ),
        ),
      ),
    ),
  ));
  await tester.pump();
  return harness;
}

void main() {
  testWidgets('the settings nav lists every sub-route entry', (tester) async {
    await _pump(tester, _settingsShell());

    for (final route in _routes) {
      expect(
        find.descendant(of: find.byType(ListTile), matching: find.text(route[1])),
        findsOneWidget,
        reason: route[0],
      );
    }
    expect(find.text('Settings'), findsWidgets);
  });

  testWidgets('activeId highlights the active route', (tester) async {
    await _pump(tester, _settingsShell(activeId: 'settings:storage', label: 'Storage'));

    final storage = tester.widget<Text>(find.descendant(
        of: find.byType(ListTile), matching: find.text('Storage')));
    final general = tester.widget<Text>(find.descendant(
        of: find.byType(ListTile), matching: find.text('General')));
    expect(storage.style?.fontWeight, FontWeight.w600);
    expect(general.style?.fontWeight, isNot(FontWeight.w600));
  });

  testWidgets('tapping a nav entry navigates to its screen id', (tester) async {
    final harness = await _pump(tester, _settingsShell());

    await tester.tap(find.descendant(
        of: find.byType(ListTile), matching: find.text('Keybindings')));
    await tester.pump();

    expect(harness.navigated, contains('settings:keybindings'));
  });

  testWidgets('the breadcrumb carries Settings / <name>', (tester) async {
    await _pump(tester, _settingsShell(activeId: 'settings:appearance', label: 'Appearance'));

    expect(find.text('Settings'), findsWidgets);
    expect(find.text('/'), findsOneWidget);
    expect(find.text('Appearance'), findsWidgets);
  });
}
