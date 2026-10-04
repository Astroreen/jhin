import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// Recording [RenderContext] for the T62 interaction cluster: dispatched
/// actions land in [dispatched], confirm prompts in [confirms] with their
/// accept callback kept in [onConfirmAccept] so a test can decline (never
/// call it) or accept (call it) through the existing confirm mechanism.
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

Future<_Harness> _pumpNode(WidgetTester tester, Object? json) async {
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

/// The widgets wrapping [finder]'s element, innermost-first (the §2.3
/// wrapping order runs inner → outer), stopping at the [_Host] so the
/// framework's own wrappers stay out of the chain.
List<Widget> _ancestorWidgets(WidgetTester tester, Finder finder) {
  final widgets = <Widget>[];
  tester.element(finder).visitAncestorElements((element) {
    widgets.add(element.widget);
    return element.widget is! _Host;
  });
  return widgets;
}

void main() {
  group('T62 dispatch — the interaction cluster fires exactly once', () {
    testWidgets('T62 dispatch: a tap on a node with action dispatches '
        'exactly once', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Tap A',
        'action': {'path': '/ui/action/a', 'name': 'a'},
      });
      await tester.tap(find.text('Tap A'));
      await tester.pump();
      expect(harness.dispatched, [
        {'path': '/ui/action/a', 'name': 'a'},
      ]);
      debugPrint('T62_TAP_BEGIN');
      debugPrint('action tap dispatched: ${harness.dispatched.length}');
      debugPrint('T62_TAP_END');
    });

    testWidgets('T62 dispatch: a tap on a node with onTap dispatches '
        'exactly once', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Tap B',
        'onTap': {'path': '/ui/action/b', 'name': 'b'},
      });
      await tester.tap(find.text('Tap B'));
      await tester.pump();
      expect(harness.dispatched, [
        {'path': '/ui/action/b', 'name': 'b'},
      ]);
      debugPrint('T62_TAP_BEGIN');
      debugPrint('onTap tap dispatched: ${harness.dispatched.length}');
      debugPrint('T62_TAP_END');
    });

    testWidgets('T62 dispatch: onTap accepts an inline directive and '
        'dispatches it through the same path', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Go back',
        'onTap': {'op': 'back'},
      });
      await tester.tap(find.text('Go back'));
      await tester.pump();
      expect(harness.dispatched, [
        {'op': 'back'},
      ]);
    });

    testWidgets('T62 dispatch: long-press fires onLongPress and not onTap',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Hold',
        'onTap': {'path': '/ui/action/tap'},
        'onLongPress': {'path': '/ui/action/long'},
      });
      await tester.longPress(find.text('Hold'));
      await tester.pump();
      expect(harness.dispatched, [
        {'path': '/ui/action/long'},
      ]);
    });

    testWidgets('T62 dispatch: tap fires onTap and not onLongPress',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Hold',
        'onTap': {'path': '/ui/action/tap'},
        'onLongPress': {'path': '/ui/action/long'},
      });
      await tester.tap(find.text('Hold'));
      await tester.pump();
      expect(harness.dispatched, [
        {'path': '/ui/action/tap'},
      ]);
    });

    testWidgets('T62 dispatch: button dispatches exactly once per tap (no '
        'nested duplicate handler)', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'button',
        'label': 'Go',
        'action': {'path': '/ui/action/go'},
      });
      await tester.tap(find.text('Go'));
      await tester.pump();
      expect(harness.dispatched, [
        {'path': '/ui/action/go'},
      ]);
      debugPrint('T62_TAP_BEGIN');
      debugPrint('button tap dispatched: ${harness.dispatched.length}');
      debugPrint('T62_TAP_END');
    });

    testWidgets('T62 dispatch: button confirm gates its own dispatch',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'button',
        'label': 'Del',
        'action': {'path': '/ui/action/del'},
        'confirm': 'Delete?',
      });
      await tester.tap(find.text('Del'));
      await tester.pump();
      expect(harness.confirms, ['Delete?']);
      expect(harness.dispatched, isEmpty);
    });
  });

  group('T62 visuals — tooltip, cursor, focus and semantics', () {
    testWidgets('T62 visuals: tooltip wraps the node in a Tooltip with its '
        'message', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'Tip',
        'tooltip': 'hover me',
      });
      expect(find.byTooltip('hover me'), findsOneWidget);
    });

    testWidgets('T62 visuals: cursor click maps to SystemMouseCursors.click '
        'on the MouseRegion', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'Cur',
        'cursor': 'click',
      });
      final regions = find.descendant(
          of: find.byType(_Host), matching: find.byType(MouseRegion));
      expect(regions, findsOneWidget);
      expect(tester.widget<MouseRegion>(regions).cursor,
          SystemMouseCursors.click);
    });

    testWidgets('T62 visuals: an unknown cursor literal degrades to the '
        'default cursor, no throw', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'Cur 2',
        'cursor': 'nope',
      });
      final regions = find.descendant(
          of: find.byType(_Host), matching: find.byType(MouseRegion));
      expect(regions, findsOneWidget);
      expect(tester.widget<MouseRegion>(regions).cursor, MouseCursor.defer);
      expect(tester.takeException(), isNull);
    });

    testWidgets('T62 visuals: semantics props land on the Semantics wrapper',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'A11y',
        'semanticsLabel': 'save label',
        'semanticsHint': 'saves the file',
        'semanticsValue': 'ready',
      });
      final semantics = tester.widget<Semantics>(find.byWidgetPredicate(
          (widget) => widget is Semantics && widget.properties.label == 'save label'));
      expect(semantics.properties.hint, 'saves the file');
      expect(semantics.properties.value, 'ready');
    });

    testWidgets('T62 visuals: focusable true wraps the node in a Focus',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'Foc',
        'focusable': true,
      });
      expect(
        find.descendant(of: find.byType(_Host), matching: find.byType(Focus)),
        findsOneWidget,
      );
    });
  });

  group('T62 no-op — declined confirm and enabled: false dispatch nothing',
      () {
    testWidgets('T62 no-op: a declined confirm dispatches nothing',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Danger',
        'onTap': {'path': '/ui/action/boom'},
        'confirm': 'Sure?',
      });
      await tester.tap(find.text('Danger'));
      await tester.pump();
      debugPrint('T62_NOOP_BEGIN');
      debugPrint('declined confirm: confirms=${harness.confirms.length} '
          'dispatched=${harness.dispatched.length}');
      debugPrint('T62_NOOP_END');
      expect(harness.confirms, ['Sure?']);
      expect(harness.dispatched, isEmpty);
      // Accept through the same confirm callback the runtime hands out.
      harness.onConfirmAccept!();
      await tester.pump();
      expect(harness.dispatched, [
        {'path': '/ui/action/boom'},
      ]);
    });

    testWidgets('T62 no-op: enabled false drops tap, long-press and focus',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Off',
        'action': {'path': '/ui/action/x'},
        'onLongPress': {'path': '/ui/action/y'},
        'focusable': true,
        'enabled': false,
        'tooltip': 'still here',
      });
      await tester.tap(find.text('Off'), warnIfMissed: false);
      await tester.longPress(find.text('Off'), warnIfMissed: false);
      await tester.pump();
      final focus = find.descendant(
          of: find.byType(_Host), matching: find.byType(Focus));
      debugPrint('T62_NOOP_BEGIN');
      debugPrint('enabled:false tap+long-press dispatched: '
          '${harness.dispatched.length}');
      debugPrint('enabled:false focus wrappers: ${focus.evaluate().length}');
      debugPrint('T62_NOOP_END');
      expect(harness.dispatched, isEmpty);
      expect(focus, findsNothing);
      expect(find.byTooltip('still here'), findsOneWidget);
    });

    testWidgets('T62 no-op: enabled false on a button drops its dispatch',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'button',
        'label': 'Go',
        'action': {'path': '/ui/action/go'},
        'enabled': false,
      });
      await tester.tap(find.text('Go'), warnIfMissed: false);
      await tester.pump();
      debugPrint('T62_NOOP_BEGIN');
      debugPrint('button enabled:false dispatched: ${harness.dispatched.length}');
      debugPrint('T62_NOOP_END');
      expect(harness.dispatched, isEmpty);
    });
  });

  group('T62 order — the §2.3 wrap order of the interaction cluster', () {
    testWidgets('T62 order: the interaction cluster wraps in the documented '
        'wrap order', (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'color': '#ff0000',
        'padding': 4,
        'tooltip': 'tip',
        'action': {'path': '/ui/action/tap'},
        'onLongPress': {'path': '/ui/action/long'},
        'cursor': 'click',
        'focusable': true,
        'semanticsLabel': 'lbl',
        'margin': 8,
        'children': [
          {'type': 'text', 'text': 'X'},
        ],
      });
      final chain = _ancestorWidgets(tester, find.text('X'));

      // Innermost-first: the §2.3 order runs inner → outer, so the cluster
      // must appear as Tooltip → InkWell → GestureDetector(onLongPress) →
      // Focus → Semantics → MouseRegion. Focus, Semantics and MouseRegion
      // are looked up at their LAST occurrence — ours are the outermost of
      // their type inside the node (the InkWell owns inner ones).
      final tooltipIdx = chain.indexWhere((w) => w is Tooltip);
      final inkIdx = chain.indexWhere((w) => w is InkWell);
      final gestureIdx =
          chain.indexWhere((w) => w is GestureDetector && w.onLongPress != null);
      final focusIdx = chain.lastIndexWhere((w) => w is Focus);
      final semanticsIdx = chain.lastIndexWhere((w) => w is Semantics);
      final mouseIdx = chain.lastIndexWhere((w) => w is MouseRegion);

      debugPrint('T62_TREE_BEGIN');
      debugPrint('widget tree excerpt, innermost-first (§2.3 runs inner -> outer):');
      for (final widget in chain) {
        debugPrint('  ${widget.runtimeType}');
      }
      debugPrint('cluster indices (innermost-first): '
          'Tooltip=$tooltipIdx InkWell=$inkIdx GestureDetector=$gestureIdx '
          'Focus=$focusIdx Semantics=$semanticsIdx MouseRegion=$mouseIdx');
      debugPrint('T62_TREE_END');

      expect([tooltipIdx, inkIdx, gestureIdx, focusIdx, semanticsIdx, mouseIdx],
          everyElement(greaterThanOrEqualTo(0)));
      expect(tooltipIdx, lessThan(inkIdx));
      expect(inkIdx, lessThan(gestureIdx));
      expect(gestureIdx, lessThan(focusIdx));
      expect(focusIdx, lessThan(semanticsIdx));
      expect(semanticsIdx, lessThan(mouseIdx));
    });
  });
}
