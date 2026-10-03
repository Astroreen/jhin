import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// Recording [RenderContext]: dispatched actions and confirm prompts land
/// in lists so the gesture wrapper (§2.3 step 12) can be asserted.
class _Harness {
  final state = UiState();
  final dispatched = <Map<String, dynamic>>[];
  final confirms = <String>[];

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
    confirm: (message, onConfirm) => confirms.add(message),
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
  JhinTheme? design,
}) async {
  final harness = _Harness();
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: JhinDesignScope(
        design: design ?? JhinTheme.fallback(),
        child: Material(
          child: _Host(harness, node),
        ),
      ),
    ),
  ));
  await tester.pump();
  return harness;
}

void main() {
  group('Universal props — token resolution (§2.2)', () {
    testWidgets('\$spacing.lg in padding → EdgeInsets.all(16)', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'P',
        'padding': '\$spacing.lg',
      });
      final padding = tester.widget<Padding>(
        find.ancestor(of: find.text('P'), matching: find.byType(Padding)).first,
      );
      expect(padding.padding, const EdgeInsets.all(16));
    });

    testWidgets('\$spacing.xl in margin → EdgeInsets.all(24)', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'M',
        'margin': '\$spacing.xl',
      });
      expect(
        find.byWidgetPredicate((widget) =>
            widget is Padding && widget.padding == const EdgeInsets.all(24)),
        findsOneWidget,
      );
    });

    testWidgets('token components resolve inside padding maps', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'C',
        'padding': {'top': '\$spacing.md', 'left': 4},
      });
      final padding = tester.widget<Padding>(
        find.ancestor(of: find.text('C'), matching: find.byType(Padding)).first,
      );
      expect(padding.padding, const EdgeInsets.fromLTRB(4, 12, 0, 0));
    });

    testWidgets('unknown \$foo.bar degrades to the literal, node renders',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'U',
        'padding': '\$foo.bar',
      });
      expect(find.text('U'), findsOneWidget);
      expect(
        find.ancestor(of: find.text('U'), matching: find.byType(Padding)),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('unknown token inside a padding map degrades the padding',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'V',
        'padding': {'top': '\$spacing.nope'},
      });
      expect(find.text('V'), findsOneWidget);
      expect(
        find.ancestor(of: find.text('V'), matching: find.byType(Padding)),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('\$color.accent resolves to the palette color', (tester) async {
      await _pumpNode(
        tester,
        {
          'type': 'container',
          'color': '\$color.accent',
          'children': [
            {'type': 'text', 'text': 'A'},
          ],
        },
        design: JhinTheme.from(accent: '#7e57c2'),
      );
      final box = tester.widget<DecoratedBox>(find.byType(DecoratedBox));
      final decoration = box.decoration as BoxDecoration;
      expect(decoration.color, const Color(0xFF7E57C2));
    });

    testWidgets('content props keep a leading \$ literal', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': '\$spacing.md',
      });
      expect(find.text('\$spacing.md'), findsOneWidget);
    });
  });

  group('Universal props — fixed wrapping order (§2.3)', () {
    testWidgets('padding+margin+opacity+tooltip+action+semantics wrap in the '
        'documented order', (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'color': '#ff0000',
        'padding': 4,
        'margin': 8,
        'opacity': 0.5,
        'tooltip': 'tip',
        'action': {'path': '/ui/action/tap', 'name': 'tap'},
        'semanticsLabel': 'lbl',
        'children': [
          {'type': 'text', 'text': 'X'},
        ],
      });

      // Each wrapper is uniquely identifiable (by value or property), so
      // pairwise ancestor assertions pin the §2.3 order:
      // DecoratedBox → Padding(padding) → Opacity → Tooltip → gesture
      // (InkWell on a Material surface) → Semantics → Padding(margin).
      final text = find.text('X');
      final decorated = find.byType(DecoratedBox);
      final innerPadding = find.byWidgetPredicate(
          (widget) => widget is Padding && widget.padding == const EdgeInsets.all(4));
      final opacity = find.byType(Opacity);
      final tooltip = find.byType(Tooltip);
      final gesture = find.byType(InkWell);
      final semantics = find.byWidgetPredicate((widget) =>
          widget is Semantics && widget.properties.label == 'lbl');
      final outerPadding = find.byWidgetPredicate(
          (widget) => widget is Padding && widget.padding == const EdgeInsets.all(8));

      expect(find.ancestor(of: text, matching: decorated), findsOneWidget);
      expect(find.ancestor(of: decorated, matching: innerPadding), findsOneWidget);
      expect(find.ancestor(of: innerPadding, matching: opacity), findsOneWidget);
      expect(find.ancestor(of: opacity, matching: tooltip), findsOneWidget);
      expect(find.ancestor(of: tooltip, matching: gesture), findsOneWidget);
      expect(find.ancestor(of: gesture, matching: semantics), findsOneWidget);
      expect(find.ancestor(of: semantics, matching: outerPadding), findsOneWidget);
    });

    testWidgets('flex+margin: the margin sits inside the Expanded (Flutter '
        'requires flex children to be direct Flex children)', (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'direction': 'row',
        'children': [
          {'type': 'text', 'text': 'F', 'flex': 1, 'margin': 8},
        ],
      });
      expect(tester.takeException(), isNull);
      final expanded = tester.widget<Expanded>(find.byType(Expanded));
      expect(expanded.flex, 1);
      final margin = expanded.child as Padding;
      expect(margin.padding, const EdgeInsets.all(8));
    });

    testWidgets('flex outside a Flex degrades silently (no crash)',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'S',
        'flex': 2,
      });
      expect(find.text('S'), findsOneWidget);
      expect(find.byType(Expanded), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('Universal props — decoration, text style, gesture', () {
    testWidgets('text style props merge into the Text widget', (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'T',
        'fontSize': 40,
        'textAlign': 'center',
        'maxLines': 2,
      });
      final text = tester.widget<Text>(find.text('T'));
      expect(text.style!.fontSize, 40);
      expect(text.textAlign, TextAlign.center);
      expect(text.maxLines, 2);
    });

    testWidgets('border+borderRadius produce a DecoratedBox border',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'border': '#00ff00',
        'borderRadius': '\$radius.md',
        'children': [
          {'type': 'text', 'text': 'B'},
        ],
      });
      final box = tester.widget<DecoratedBox>(find.byType(DecoratedBox));
      final decoration = box.decoration as BoxDecoration;
      expect(decoration.border!.top.color, const Color(0xFF00FF00));
      expect(decoration.borderRadius, BorderRadius.circular(10));
    });

    testWidgets('a tap on a node with an action dispatches it', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Tap me',
        'action': {'path': '/ui/action/ping', 'name': 'ping'},
      });
      await tester.tap(find.text('Tap me'));
      expect(harness.dispatched, [
        {'path': '/ui/action/ping', 'name': 'ping'},
      ]);
    });

    testWidgets('confirm shows the dialog before dispatching', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Danger',
        'action': {'path': '/ui/action/boom'},
        'confirm': 'Sure?',
      });
      await tester.tap(find.text('Danger'));
      expect(harness.confirms, ['Sure?']);
      expect(harness.dispatched, isEmpty);
    });

    testWidgets('enabled: false keeps layout and drops the interaction',
        (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Off',
        'action': {'path': '/ui/action/x'},
        'enabled': false,
      });
      await tester.tap(find.text('Off'), warnIfMissed: false);
      expect(harness.dispatched, isEmpty);
      expect(find.text('Off'), findsOneWidget);
    });

    testWidgets('onLongPress dispatches its own action', (tester) async {
      final harness = await _pumpNode(tester, {
        'type': 'text',
        'text': 'Hold',
        'onLongPress': {'path': '/ui/action/long'},
      });
      await tester.longPress(find.text('Hold'));
      expect(harness.dispatched, [
        {'path': '/ui/action/long'},
      ]);
    });

    testWidgets('semantics props wire into a Semantics wrapper',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'A11y',
        'semanticsLabel': 'accessible',
        'semanticsHint': 'hint text',
      });
      final semantics = tester.widget<Semantics>(
        find
            .ancestor(of: find.text('A11y'), matching: find.byType(Semantics))
            .first,
      );
      expect(semantics.properties.label, 'accessible');
      expect(semantics.properties.hint, 'hint text');
    });
  });

  group('Universal props — degrade rules (§2.4)', () {
    testWidgets('unknown primitive still renders the muted card',
        (tester) async {
      await _pumpNode(tester, {'type': 'teleporter'});
      expect(find.textContaining('Unsupported UI element: teleporter'),
          findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('malformed decoration props degrade, node renders',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'color': 'not-a-color',
        'gradient': {'type': 'wat', 'colors': []},
        'shadow': 'garbage',
        'clip': 'sideways',
        'transform': [1, 2, 3],
        'align': 'nowhere',
        'children': [
          {'type': 'text', 'text': 'D'},
        ],
      });
      expect(find.text('D'), findsOneWidget);
      expect(find.byType(DecoratedBox), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a malformed constraint set degrades to no constraints',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'text',
        'text': 'K',
        'minWidth': 100,
        'maxWidth': 10,
      });
      expect(find.text('K'), findsOneWidget);
      final boxes = tester.widgetList<ConstrainedBox>(find.ancestor(
          of: find.text('K'), matching: find.byType(ConstrainedBox)));
      expect(
        boxes.any((box) => box.constraints.maxWidth == 10),
        isFalse,
      );
      expect(tester.takeException(), isNull);
    });
  });
}
