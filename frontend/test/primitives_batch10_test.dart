import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/sdui_runtime.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';

/// T65 acceptance: `tabs`, `segmented`, `shell` and `nav` v2 (docs/sdui.md
/// §2.5–§2.6). The shell goldens live beside the T57 gallery baselines at
/// `gallery/goldens/shell-wide.png` / `gallery/goldens/shell-narrow.png`
/// (the custom-surface golden pattern of `gallery/thread_row_golden_test.dart`).
class _Harness {
  final state = UiState();
  final dispatched = <Map<String, dynamic>>[];
  final patches = <String, Map<String, dynamic>>{};

  late final RenderContext ctx = RenderContext(
    state: state,
    registry: UiRegistry.standard(),
    patches: patches,
    setState: (id, value) => state.setValue(id, value),
    patch: (id, props) => patches[id] = {...?patches[id], ...props},
    navigate: (screen) {},
    dispatch: (action) async =>
        dispatched.add(Map<String, dynamic>.from(action)),
    openStream: (topic, {onStatus}) => const Stream.empty(),
    runDirectives: (directives) async {},
    confirm: (message, onConfirm) {},
  );
}

class _Host extends StatelessWidget {
  const _Host(this.harness, this.node);

  final _Harness harness;
  final UiNode node;

  @override
  Widget build(BuildContext context) => harness.ctx.build(context, node);
}

Future<_Harness> _pumpNode(
  WidgetTester tester,
  Object? json, {
  Size? surfaceSize,
}) async {
  if (surfaceSize != null) {
    tester.view.physicalSize = surfaceSize;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
  }
  final harness = _Harness();
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: JhinDesignScope(
        design: JhinTheme.fallback(),
        child: Material(
          child: _Host(harness, node),
        ),
      ),
    ),
  ));
  await tester.pump();
  return harness;
}

Widget _runtimeHost(SduiRuntime runtime, Map<String, dynamic> payload) =>
    MaterialApp(
      home: Builder(builder: (context) => runtime.buildScreen(context, payload)),
    );

Map<String, Object> _action(String name) => {
      'name': name,
      'method': 'POST',
      'path': '/ui/action/$name',
    };

final Object _tabsNode = {
  'type': 'tabs',
  'id': 'tabs',
  'items': [
    {
      'label': 'One',
      'panel': {'type': 'text', 'text': 'panel-1'}
    },
    {
      'label': 'Two',
      'panel': {'type': 'text', 'text': 'panel-2'}
    },
  ],
};

final Object _segmentedNode = {
  'type': 'segmented',
  'id': 'seg',
  'segments': [
    {'label': 'Day', 'value': 'day'},
    {'label': 'Week', 'value': 'week'},
    {'label': 'Month', 'value': 'month'},
  ],
  'value': 'day',
  'action': _action('change'),
};

final Object _navSidebar = {
  'type': 'nav',
  'kind': 'sidebar',
  'activeId': 'settings',
  'items': [
    {
      'id': 'home',
      'label': 'Home',
      'icon': 'home',
      'section': 'Main',
      'screen': 'home'
    },
    {
      'id': 'settings',
      'label': 'Settings',
      'icon': 'settings',
      'section': 'Main',
      'screen': 'settings'
    },
    {
      'label': 'Alerts',
      'section': 'Main',
      'count': 3,
      'action': _action('alerts')
    },
    {
      'label': 'Marked',
      'section': 'Main',
      'badge': {
        'type': 'badge',
        'label': 'new'
      },
      'action': _action('marked')
    },
    {
      'label': 'Off',
      'section': 'Main',
      'enabled': false,
      'action': _action('off')
    },
    {
      'label': 'Old',
      'section': 'Settled',
      'collapsible': true,
      'collapsed': true,
      'action': _action('old')
    },
    {'label': 'Older', 'section': 'Settled', 'action': _action('older')},
  ],
};

Map<String, Object> _shellNode({bool withBody = true}) => {
      'type': 'shell',
      'id': 'shell',
      'collapsible': true,
      'sidebar': {
        'type': 'nav',
        'kind': 'sidebar',
        'items': [
          {
            'label': 'Home',
            'icon': 'home',
            'section': 'Main',
            'screen': 'home'
          },
        ],
      },
      'header': {'type': 'text', 'text': 'shell-header'},
      if (withBody) 'body': {'type': 'text', 'text': 'shell-body'},
      'detail': {'type': 'text', 'text': 'shell-detail'},
      'rail': {
        'type': 'nav',
        'kind': 'rail',
        'items': [
          {'label': 'Inbox', 'icon': 'inbox'},
        ],
      },
    };

void main() {
  group('tabs', () {
    testWidgets('renders item labels and swaps the visible panel on tap',
        (tester) async {
      final h = await _pumpNode(tester, _tabsNode);
      expect(find.text('One'), findsOneWidget);
      expect(find.text('Two'), findsOneWidget);
      expect(find.text('panel-1'), findsOneWidget);
      expect(find.text('panel-2'), findsNothing);

      await tester.tap(find.text('Two'));
      await tester.pump();
      expect(find.text('panel-2'), findsOneWidget);
      expect(find.text('panel-1'), findsNothing);
      debugPrint('T65_TABS_SWAP items=2 activeIndex=1 panel=panel-2 visible=1');
      expect(h.dispatched, isEmpty);
    });

    testWidgets('underline and pill variants render distinctly',
        (tester) async {
      Object node(String variant) => {
            'type': 'tabs',
            'variant': variant,
            'items': [
              {
                'label': 'One',
                'panel': {'type': 'text', 'text': 'panel-1'}
              },
              {
                'label': 'Two',
                'panel': {'type': 'text', 'text': 'panel-2'}
              },
            ],
          };
      final underlineIndicator = find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).border?.bottom.width == 2 &&
            (w.decoration as BoxDecoration).border?.bottom.color !=
                Colors.transparent,
      );
      final pillShape = find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration as BoxDecoration).borderRadius != null,
      );

      await _pumpNode(tester, node('underline'));
      expect(underlineIndicator, findsOneWidget);
      expect(pillShape, findsNothing);

      await _pumpNode(tester, node('pill'));
      expect(pillShape, findsWidgets);
      expect(underlineIndicator, findsNothing);
      debugPrint('T65_TABS_VARIANTS underline=indicator pill=rounded distinct=1');
    });

    testWidgets('a patch frame on the node id swaps the panel back',
        (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(_runtimeHost(runtime, sduiPayload(
        entry: 'home',
        screens: {
          'home': {
            'type': 'tabs',
            'id': 'tabs',
            'activeIndex': 0,
            'items': [
              {
                'label': 'One',
                'panel': {'type': 'text', 'text': 'panel-1'}
              },
              {
                'label': 'Two',
                'panel': {'type': 'text', 'text': 'panel-2'}
              },
            ],
          },
        },
      )));
      await tester.pump();
      expect(find.text('panel-1'), findsOneWidget);

      await tester.tap(find.text('Two'));
      await tester.pump();
      expect(find.text('panel-2'), findsOneWidget);
      expect(find.text('panel-1'), findsNothing);

      await runtime.runDirectives([
        {'op': 'patch', 'id': 'tabs', 'props': {'activeIndex': 0}},
      ]);
      await tester.pump();
      expect(find.text('panel-1'), findsOneWidget);
      expect(find.text('panel-2'), findsNothing);
      debugPrint('T65_TABS_PATCH id=tabs activeIndex=0 panel=panel-1 restored=1');
    });
  });

  group('segmented', () {
    testWidgets('renders options and dispatches the change action once',
        (tester) async {
      final h = await _pumpNode(tester, _segmentedNode);
      expect(find.text('Day'), findsOneWidget);
      expect(find.text('Week'), findsOneWidget);
      expect(find.text('Month'), findsOneWidget);

      await tester.tap(find.text('Week'));
      await tester.pump();
      expect(h.dispatched, hasLength(1));
      expect(h.dispatched.single['name'], 'change');
      expect(h.state['seg'], 'week');
      debugPrint('T65_SEGMENTS_SELECT options=3 dispatched=1 value=week');
    });

    testWidgets('enabled false renders a disabled control', (tester) async {
      final h = await _pumpNode(tester, {
        'type': 'segmented',
        'id': 'seg',
        'enabled': false,
        'segments': [
          {'label': 'Day', 'value': 'day'},
          {'label': 'Week', 'value': 'week'},
        ],
        'action': _action('change'),
      });
      await tester.tap(find.text('Week'), warnIfMissed: false);
      await tester.pump();
      expect(h.dispatched, isEmpty);
    });
  });

  group('nav v2', () {
    testWidgets('sidebar kind renders section groups, badge and count',
        (tester) async {
      await _pumpNode(tester, _navSidebar);
      expect(find.text('Main'), findsOneWidget);
      expect(find.text('Settled'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(find.text('new'), findsOneWidget);
      debugPrint(
          'T65_NAV_SECTIONS sections=Main|Settled badge=1 count=1 items=5');
    });

    testWidgets('enabled false item dispatches nothing on tap', (tester) async {
      final h = await _pumpNode(tester, _navSidebar);
      await tester.tap(find.text('Off'), warnIfMissed: false);
      await tester.pump();
      expect(h.dispatched, isEmpty);
      debugPrint('T65_NAV_DISABLED tap=Off dispatched=0');
    });

    testWidgets('activeId highlights the matching item', (tester) async {
      await _pumpNode(tester, _navSidebar);
      final settings = tester.widget<Text>(find.text('Settings'));
      final home = tester.widget<Text>(find.text('Home'));
      expect(settings.style?.fontWeight, FontWeight.w600);
      expect(home.style?.fontWeight, isNot(FontWeight.w600));
    });

    testWidgets('unknown activeId falls back to activeIndex without crashing',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'nav',
        'kind': 'sidebar',
        'activeId': 'nope',
        'activeIndex': 1,
        'items': [
          {'id': 'home', 'label': 'Home', 'section': 'Main', 'screen': 'home'},
          {
            'id': 'settings',
            'label': 'Settings',
            'section': 'Main',
            'screen': 'settings'
          },
        ],
      });
      final settings = tester.widget<Text>(find.text('Settings'));
      expect(settings.style?.fontWeight, FontWeight.w600);
      debugPrint('T65_ACTIVEID_FALLBACK activeId=nope matched=0 '
          'fallback=activeIndex:1 crash=0');
    });

    testWidgets('a collapsible section shelf starts collapsed and toggles',
        (tester) async {
      await _pumpNode(tester, _navSidebar);
      expect(find.text('Old'), findsNothing);
      expect(find.text('Older'), findsNothing);

      await tester.tap(find.text('Settled'));
      await tester.pump();
      expect(find.text('Old'), findsOneWidget);
      expect(find.text('Older'), findsOneWidget);
    });
  });

  group('shell', () {
    testWidgets('wide surface renders sidebar, header, body, detail and rail',
        (tester) async {
      await _pumpNode(tester, _shellNode(), surfaceSize: const Size(1200, 800));
      expect(
        find.byWidgetPredicate((w) => w is SizedBox && w.width == 280),
        findsOneWidget,
      );
      expect(find.text('shell-header'), findsOneWidget);
      expect(find.text('shell-body'), findsOneWidget);
      expect(find.text('shell-detail'), findsOneWidget);
      expect(find.byType(NavigationRail), findsOneWidget);
      debugPrint('T65_SHELL_WIDE width=1200 breakpoint=900 sidebar=280 '
          'slots=sidebar,header,body,detail,rail');
    });

    testWidgets('shell-wide golden', (tester) async {
      tester.view.physicalSize = const Size(1200, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final design = JhinTheme.from(density: 'comfortable');
      await tester.pumpWidget(MaterialApp(
        theme: design.light,
        darkTheme: design.dark,
        themeMode: ThemeMode.light,
        home: Scaffold(
          body: JhinDesignScope(
            design: design,
            child: Material(
              child: _Host(_Harness(), UiNode.fromJson(_shellNode())),
            ),
          ),
        ),
      ));
      await tester.pump();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('gallery/goldens/shell-wide.png'),
      );
    });

    testWidgets('narrow surface moves the sidebar into a drawer',
        (tester) async {
      await _pumpNode(tester, _shellNode(), surfaceSize: const Size(700, 800));
      expect(find.byIcon(Icons.menu), findsOneWidget);
      expect(
        find.byWidgetPredicate((w) => w is SizedBox && w.width == 280),
        findsNothing,
      );
      expect(find.text('Home'), findsNothing);
      debugPrint('T65_SHELL_NARROW width=700 breakpoint=900 '
          'sidebar=drawer hamburger=1');

      await tester.tap(find.byIcon(Icons.menu));
      await tester.pumpAndSettle();
      expect(find.byType(Drawer), findsOneWidget);
      expect(find.text('Home'), findsOneWidget);
    });

    testWidgets('shell-narrow golden', (tester) async {
      tester.view.physicalSize = const Size(700, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final design = JhinTheme.from(density: 'comfortable');
      await tester.pumpWidget(MaterialApp(
        theme: design.light,
        darkTheme: design.dark,
        themeMode: ThemeMode.light,
        home: Scaffold(
          body: JhinDesignScope(
            design: design,
            child: Material(
              child: _Host(_Harness(), UiNode.fromJson(_shellNode())),
            ),
          ),
        ),
      ));
      await tester.pump();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('gallery/goldens/shell-narrow.png'),
      );
    });

    testWidgets('missing body degrades to a card', (tester) async {
      await _pumpNode(tester, _shellNode(withBody: false),
          surfaceSize: const Size(1200, 800));
      expect(find.text('Missing body'), findsOneWidget);
      expect(find.byType(Card), findsOneWidget);
      debugPrint('T65_MISSING_BODY rendered=card text=Missing body exceptions=0');
    });

    testWidgets('collapsed patches the sidebar width and back', (tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      tester.view.physicalSize = const Size(1200, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      await tester.pumpWidget(_runtimeHost(runtime, sduiPayload(
        entry: 'home',
        screens: {
          'home': {
            'type': 'shell',
            'id': 'shell',
            'collapsible': true,
            'sidebar': {'type': 'text', 'text': 'side'},
            'body': {'type': 'text', 'text': 'shell-body'},
          },
        },
      )));
      await tester.pump();
      expect(
        find.byWidgetPredicate((w) => w is SizedBox && w.width == 280),
        findsOneWidget,
      );

      await runtime.runDirectives([
        {'op': 'patch', 'id': 'shell', 'props': {'collapsed': true}},
      ]);
      await tester.pump();
      expect(
        find.byWidgetPredicate((w) => w is SizedBox && w.width == 56),
        findsOneWidget,
      );
      debugPrint('T65_PATCH_COLLAPSED id=shell collapsed=true width=56');

      await runtime.runDirectives([
        {'op': 'patch', 'id': 'shell', 'props': {'collapsed': false}},
      ]);
      await tester.pump();
      expect(
        find.byWidgetPredicate((w) => w is SizedBox && w.width == 280),
        findsOneWidget,
      );
      debugPrint('T65_PATCH_COLLAPSED id=shell collapsed=false width=280');
    });
  });
}
