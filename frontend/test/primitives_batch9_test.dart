import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/sdui_runtime.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';

/// T64 acceptance: `menu`, `sheet`, `dialog`, `banner` (docs/sdui.md §2.6)
/// and the `dialog` directive `kind` (§4).
class _Harness {
  final state = UiState();
  final dispatched = <Map<String, dynamic>>[];
  final confirms = <String>[];
  VoidCallback? onConfirmAccept;

  late final RenderContext ctx = RenderContext(
    state: state,
    registry: UiRegistry.standard(),
    patches: {},
    setState: (id, value) => state.setValue(id, value),
    patch: (id, props) {},
    navigate: (screen) {},
    dispatch: (action) async =>
        dispatched.add(Map<String, dynamic>.from(action)),
    openStream: (topic, {onStatus}) => const Stream.empty(),
    runDirectives: (directives) async {},
    confirm: (message, onConfirm) {
      confirms.add(message);
      onConfirmAccept = onConfirm;
    },
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

/// The 4-item menu node of the T64 acceptance (plan: one `divider`, one
/// `danger`+`confirm`): wide surfaces open the popup, narrow ones the sheet.
final Object _menuNode = {
  'type': 'menu',
  'trigger': {'type': 'text', 'text': 'Open menu'},
  'items': [
    {
      'label': 'Open',
      'icon': 'settings',
      'action': {'name': 'open', 'method': 'POST', 'path': '/ui/action/open'},
    },
    {
      'label': 'Delete',
      'danger': true,
      'confirm': 'Delete it?',
      'action': {'name': 'delete', 'method': 'POST', 'path': '/ui/action/delete'},
    },
    {
      'label': 'Disabled',
      'disabled': true,
      'action': {
        'name': 'disabled',
        'method': 'POST',
        'path': '/ui/action/disabled'
      },
    },
    {'divider': true},
  ],
};

/// Opens the menu on a wide (popup) surface and returns the harness.
Future<_Harness> _openMenu(WidgetTester tester) async {
  final harness = await _pumpNode(tester, _menuNode,
      surfaceSize: const Size(1200, 800));
  await tester.tap(find.text('Open menu'), warnIfMissed: false);
  await tester.pumpAndSettle();
  return harness;
}

void main() {
  group('menu', () {
    testWidgets('trigger tap opens the menu with exactly 4 items',
        (tester) async {
      await _openMenu(tester);
      expect(find.text('Open'), findsOneWidget);
      expect(find.text('Delete'), findsOneWidget);
      expect(find.text('Disabled'), findsOneWidget);
      expect(find.byType(PopupMenuDivider), findsOneWidget);
      expect(find.byType(Divider), findsOneWidget);
      final entries = tester.allWidgets
          .where((w) => w is PopupMenuItem<int> || w is PopupMenuDivider)
          .toList();
      expect(entries, hasLength(4));

      debugPrint('T64_MENU_TREE_BEGIN');
      debugPrint('widget tree excerpt of the open menu (popup route):');
      for (final widget in tester.allWidgets.where((w) =>
          w is PopupMenuButton<int> ||
          w is PopupMenuItem<int> ||
          w is PopupMenuDivider ||
          w is Divider)) {
        debugPrint('  ${widget.runtimeType}');
      }
      final items = (UiNode.fromJson(_menuNode).listProp('items'))!;
      for (var i = 0; i < items.length; i++) {
        debugPrint('  item[$i] ${items[i]}');
      }
      debugPrint(
          'T64_MENU_TREE items=${items.length} entries=${entries.length} labels=Open|Delete|Disabled|divider');
      debugPrint('T64_MENU_TREE_END');
    });

    testWidgets('item with an action dispatches exactly once', (tester) async {
      final harness = await _openMenu(tester);
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'open');
    });

    testWidgets('a declined confirm dispatches nothing', (tester) async {
      final harness = await _openMenu(tester);
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(harness.confirms, ['Delete it?']);
      expect(harness.dispatched, isEmpty);
    });

    testWidgets('disabled item dispatches nothing', (tester) async {
      final harness = await _openMenu(tester);
      await tester.tap(find.text('Disabled'), warnIfMissed: false);
      await tester.pump();
      expect(harness.dispatched, isEmpty);
    });

    testWidgets('danger item is styled distinctly', (tester) async {
      await _openMenu(tester);
      final label = tester.widget<Text>(find.text('Delete'));
      final scheme = Theme.of(tester.element(find.text('Delete'))).colorScheme;
      expect(label.style?.color, scheme.error);
    });

    testWidgets('below the breakpoint the items open as a bottom sheet',
        (tester) async {
      final harness = await _pumpNode(tester, _menuNode,
          surfaceSize: const Size(400, 800));
      await tester.tap(find.text('Open menu'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(find.text('Open'), findsOneWidget);
      expect(find.text('Delete'), findsOneWidget);
      expect(find.text('Disabled'), findsOneWidget);
      expect(find.byType(Divider), findsOneWidget);
      debugPrint('T64_NARROW_MENU width=400 breakpoint=900 '
          'variant=bottom-sheet items=4 dispatched=0');

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'open');
      debugPrint('T64_NARROW_MENU width=400 breakpoint=900 '
          'variant=bottom-sheet items=4 dispatched=1');
    });
  });

  group('sheet', () {
    testWidgets('renders title/body/footer', (tester) async {
      await _pumpNode(tester, {
        'type': 'sheet',
        'title': 'Sheet title',
        'body': {'type': 'text', 'text': 'Sheet body'},
        'footer': {'type': 'text', 'text': 'Sheet footer'},
      });
      expect(find.text('Sheet title'), findsOneWidget);
      expect(find.text('Sheet body'), findsOneWidget);
      expect(find.text('Sheet footer'), findsOneWidget);
    });

    testWidgets('dismissible false blocks outside-tap close', (tester) async {
      await _pumpNode(tester, {
        'type': 'sheet',
        'title': 'Sheet title',
        'body': {'type': 'text', 'text': 'Sheet body'},
        'dismissible': false,
      });
      await tester.tapAt(const Offset(400, 30));
      await tester.pump();
      expect(find.text('Sheet title'), findsOneWidget);
    });

    testWidgets('dismissible true closes on outside tap', (tester) async {
      await _pumpNode(tester, {
        'type': 'sheet',
        'title': 'Sheet title',
        'body': {'type': 'text', 'text': 'Sheet body'},
      });
      await tester.tapAt(const Offset(400, 30));
      await tester.pump();
      expect(find.text('Sheet title'), findsNothing);
    });

    testWidgets('height sizes the sheet panel', (tester) async {
      await _pumpNode(tester, {
        'type': 'sheet',
        'title': 'Sheet title',
        'body': {'type': 'text', 'text': 'Sheet body'},
        'height': 300,
      });
      expect(find.text('Sheet title'), findsOneWidget);
      expect(
          find.byWidgetPredicate((w) => w is SizedBox && w.height == 300),
          findsOneWidget);
    });
  });

  group('dialog directive', () {
    Future<SduiRuntime> pumpRuntime(WidgetTester tester) async {
      final transport = ScriptedTransport();
      final runtime = SduiRuntime(transport: transport);
      addTearDown(runtime.dispose);
      await tester.pumpWidget(_runtimeHost(
        runtime,
        sduiPayload(entry: 'home', screens: {
          'home': {'type': 'text', 'text': 'home-screen'},
        }),
      ));
      await tester.pump();
      return runtime;
    }

    testWidgets('kind sheet opens a bottom sheet with the content',
        (tester) async {
      final runtime = await pumpRuntime(tester);
      await runtime.runDirectives([
        {
          'op': 'dialog',
          'kind': 'sheet',
          'node': {'type': 'text', 'text': 'sheet-body'},
        },
      ]);
      await tester.pump();
      expect(find.text('sheet-body'), findsOneWidget);
      expect(tester.takeException(), isNull);
      final bottom = tester.getBottomLeft(find.text('sheet-body')).dy;
      expect(bottom, greaterThan(450));
    });

    testWidgets('without kind keeps the dialog behavior', (tester) async {
      final runtime = await pumpRuntime(tester);
      await runtime.runDirectives([
        {
          'op': 'dialog',
          'node': {'type': 'text', 'text': 'dialog-body'},
        },
      ]);
      await tester.pump();
      expect(find.text('dialog-body'), findsOneWidget);
      expect(find.byType(Card), findsOneWidget);
      final bottom = tester.getBottomLeft(find.text('dialog-body')).dy;
      expect(bottom, lessThan(450));
    });

    testWidgets('unknown kind degrades to a card without throwing',
        (tester) async {
      final runtime = await pumpRuntime(tester);
      await runtime.runDirectives([
        {
          'op': 'dialog',
          'kind': 'nope',
          'node': {'type': 'text', 'text': 'degraded-body'},
        },
      ]);
      await tester.pump();
      expect(find.text('degraded-body'), findsOneWidget);
      expect(find.byType(Card), findsOneWidget);
      expect(tester.takeException(), isNull);
      debugPrint('T64_UNKNOWN_KIND kind=nope rendered=card exceptions=0');
    });
  });

  group('dialog', () {
    testWidgets('renders title/content/actions and action tap dispatches once',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'dialog',
        'title': 'Delete plugin?',
        'content': {'type': 'text', 'text': 'This cannot be undone.'},
        'actions': [
          {
            'type': 'button',
            'label': 'Cancel',
            'style': 'text',
            'action': {
              'name': 'cancel',
              'method': 'POST',
              'path': '/ui/action/cancel'
            },
          },
          {
            'type': 'button',
            'label': 'Delete',
            'style': 'danger',
            'action': {
              'name': 'delete',
              'method': 'POST',
              'path': '/ui/action/delete'
            },
          },
        ],
      });
      expect(find.text('Delete plugin?'), findsOneWidget);
      expect(find.text('This cannot be undone.'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      expect(find.text('Delete'), findsOneWidget);
      await tester.tap(find.text('Delete'));
      await tester.pump();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'delete');
    });
  });

  group('banner', () {
    testWidgets('renders content and actions', (tester) async {
      await _pumpNode(tester, {
        'type': 'banner',
        'content': {'type': 'text', 'text': 'Offline mode'},
        'actions': [
          {
            'type': 'button',
            'label': 'Undo',
            'action': {
              'name': 'undo',
              'method': 'POST',
              'path': '/ui/action/undo'
            },
          },
        ],
      });
      expect(find.text('Offline mode'), findsOneWidget);
      expect(find.text('Undo'), findsOneWidget);
    });

    testWidgets('onDismiss dispatches once and removes the banner',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'banner',
        'content': {'type': 'text', 'text': 'Offline mode'},
        'onDismiss': {
          'name': 'dismiss',
          'method': 'POST',
          'path': '/ui/action/dismiss'
        },
      });
      expect(find.text('Offline mode'), findsOneWidget);
      expect(find.byTooltip('Dismiss'), findsOneWidget);
      await tester.tap(find.byTooltip('Dismiss'));
      await tester.pump();
      expect(harness.dispatched, hasLength(1));
      expect(harness.dispatched.single['name'], 'dismiss');
      expect(find.text('Offline mode'), findsNothing);
    });
  });
}
