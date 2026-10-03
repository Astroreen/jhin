import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T59 — `stack`/`positioned`, `wrap`, `grid` and lazy `scroll`/`list`
/// over the harness pattern of `design/universal_props_test.dart`: a no-op
/// [RenderContext] over a fresh [UiState], [UiNode.fromJson], `ctx.build`.
///
/// Client rule (§2.4/§9): unknown props and unknown enum literals degrade
/// silently — none of these tests may throw on server content.
class _Harness {
  final state = UiState();

  late final RenderContext ctx = RenderContext(
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

void main() {
  group('stack + positioned (§2.6)', () {
    testWidgets('stack overlays a positioned badge over an avatar figure',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'stack',
        'children': [
          {
            'type': 'figure',
            'shape': 'circle',
            'color': '#3D5A80',
            'width': 64,
            'height': 64,
          },
          {
            'type': 'positioned',
            'top': 0,
            'right': 0,
            'child': {
              'type': 'box',
              'color': '#C1272D',
              'borderRadius': 10,
              'padding': 4,
              'child': {'type': 'text', 'text': '3', 'color': '#FFFFFF'},
            },
          },
        ],
      });
      expect(tester.takeException(), isNull);

      final stack = find.descendant(
        of: find.byType(_Host),
        matching: find.byType(Stack),
      );
      expect(stack, findsOneWidget);
      expect(find.byType(Positioned), findsOneWidget);

      // The badge sits on the avatar's top-right corner: its center is in
      // the top-right quadrant of the (avatar-sized) stack.
      final stackRect = tester.getRect(stack);
      final badgeCenter = tester.getCenter(find.text('3'));
      expect(badgeCenter.dx, greaterThan(stackRect.center.dx));
      expect(badgeCenter.dy, lessThan(stackRect.center.dy));
    });

    testWidgets('positioned without a stack parent degrades to align',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'positioned',
        'top': 4,
        'left': 4,
        'child': {'type': 'text', 'text': 'orphan'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('orphan'), findsOneWidget);
      expect(find.byType(Positioned), findsNothing);
      expect(
        find.ancestor(
          of: find.text('orphan'),
          matching: find.byType(Align),
        ),
        findsOneWidget,
      );
    });

    testWidgets('stack fit expand fills the parent', (tester) async {
      await _pumpNode(tester, {
        'type': 'stack',
        'fit': 'expand',
        'children': [
          {'type': 'text', 'text': 'x'},
        ],
      });
      expect(tester.takeException(), isNull);
      final stack = find.descendant(
        of: find.byType(_Host),
        matching: find.byType(Stack),
      );
      expect(stack, findsOneWidget);
      expect(tester.getSize(stack), const Size(800, 600));
    });

    testWidgets('stack alignment places non-positioned children',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'stack',
        'width': 400,
        'height': 300,
        'alignment': 'bottomRight',
        'children': [
          {'type': 'text', 'text': 'loose'},
        ],
      });
      expect(tester.takeException(), isNull);
      final stackRect = tester.getRect(find.descendant(
        of: find.byType(_Host),
        matching: find.byType(Stack),
      ));
      expect(stackRect.size, const Size(400, 300));
      final childCenter = tester.getCenter(find.text('loose'));
      expect(childCenter.dx, greaterThan(stackRect.center.dx));
      expect(childCenter.dy, greaterThan(stackRect.center.dy));
    });

    testWidgets('stack clip defaults to hardEdge and fit to loose',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'stack',
        'children': [
          {'type': 'text', 'text': 'x'},
        ],
      });
      expect(tester.takeException(), isNull);
      final widget = tester.widget<Stack>(
        find.descendant(of: find.byType(_Host), matching: find.byType(Stack)),
      );
      expect(widget.fit, StackFit.loose);
      expect(widget.clipBehavior, Clip.hardEdge);
      expect(widget.alignment, Alignment.topLeft);
    });
  });

  group('wrap (§2.6)', () {
    testWidgets('wrap lays children out in runs with spacing and runSpacing',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'wrap',
        'spacing': 10,
        'runSpacing': 20,
        'children': [
          for (final label in ['a', 'b', 'c', 'd', 'e', 'f'])
            {
              'type': 'box',
              'width': 200,
              'height': 40,
              'child': {'type': 'text', 'text': label},
            },
        ],
      });
      expect(tester.takeException(), isNull);

      final tops = [
        for (final label in ['a', 'b', 'c', 'd', 'e', 'f'])
          tester.getTopLeft(find.text(label)).dy,
      ];
      final lefts = [
        for (final label in ['a', 'b', 'c', 'd', 'e', 'f'])
          tester.getTopLeft(find.text(label)).dx,
      ];
      // 200-wide children with 10 spacing fit 3 per run in 800: 2 runs.
      expect(tops.toSet().length, 2);
      // runSpacing 20 between 40-tall runs.
      expect(tops[3] - tops[0], moreOrLessEquals(60, epsilon: 0.01));
      // spacing 10 between 200-wide children.
      expect(lefts[1] - lefts[0], moreOrLessEquals(210, epsilon: 0.01));
    });

    testWidgets('wrap direction vertical runs downwards and unknown literals '
        'degrade to the defaults', (tester) async {
      await _pumpNode(tester, {
        'type': 'wrap',
        'direction': 'nope',
        'runSpacing': 12,
        'children': [
          for (final label in ['a', 'b', 'c', 'd', 'e', 'f'])
            {
              'type': 'box',
              'width': 200,
              'height': 40,
              'child': {'type': 'text', 'text': label},
            },
        ],
      });
      expect(tester.takeException(), isNull);
      final wrap = tester.widget<Wrap>(find.byType(Wrap));
      // Unknown `direction` degrades to the documented default (horizontal).
      expect(wrap.direction, Axis.horizontal);

      await _pumpNode(tester, {
        'type': 'wrap',
        'direction': 'vertical',
        'children': [
          {'type': 'text', 'text': 'a'},
          {'type': 'text', 'text': 'b'},
        ],
      });
      expect(tester.takeException(), isNull);
      expect(tester.widget<Wrap>(find.byType(Wrap)).direction, Axis.vertical);
    });
  });

  group('grid (§2.6)', () {
    testWidgets('grid with columns 3 lays 9 children out in 3 rows',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'grid',
        'columns': 3,
        'childAspectRatio': 2,
        'children': [
          for (var i = 1; i <= 9; i++) {'type': 'text', 'text': '$i'},
        ],
      });
      expect(tester.takeException(), isNull);

      final tops = [
        for (var i = 1; i <= 9; i++) tester.getTopLeft(find.text('$i')).dy,
      ];
      final lefts = [
        for (var i = 1; i <= 9; i++) tester.getTopLeft(find.text('$i')).dx,
      ];
      expect(tops.toSet().length, 3, reason: '9 cells in 3 rows');
      expect(lefts.toSet().length, 3, reason: '9 cells in 3 columns');
    });

    testWidgets('grid columns 0 degrades to 1 column', (tester) async {
      await _pumpNode(tester, {
        'type': 'grid',
        'columns': 0,
        'childAspectRatio': 8,
        'shrinkWrap': true,
        'children': [
          {'type': 'text', 'text': 'a'},
          {'type': 'text', 'text': 'b'},
          {'type': 'text', 'text': 'c'},
        ],
      });
      expect(tester.takeException(), isNull);
      final tops = [
        for (final label in ['a', 'b', 'c'])
          tester.getTopLeft(find.text(label)).dy,
      ];
      final lefts = [
        for (final label in ['a', 'b', 'c'])
          tester.getTopLeft(find.text(label)).dx,
      ];
      expect(lefts.toSet().length, 1, reason: 'one column');
      expect(tops.toSet().length, 3, reason: 'three rows');
    });

    testWidgets('missing columns degrades to a visible placeholder',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'grid',
        'children': [
          {'type': 'text', 'text': 'a'},
        ],
      });
      expect(tester.takeException(), isNull);
      expect(find.text('Missing columns'), findsOneWidget);
    });
  });

  group('scroll (§2.6)', () {
    testWidgets('eager children render without itemCount', (tester) async {
      await _pumpNode(tester, {
        'type': 'scroll',
        'children': [
          {'type': 'text', 'text': 'first'},
          {'type': 'text', 'text': 'second'},
        ],
      });
      expect(tester.takeException(), isNull);
      expect(find.text('first'), findsOneWidget);
      expect(find.text('second'), findsOneWidget);
    });

    testWidgets('scroll items with itemCount build only visible children',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'scroll',
        'itemCount': 10000,
        'items': [for (var i = 0; i < 10000; i++) 'row $i'],
      });
      expect(tester.takeException(), isNull);
      expect(find.text('row 0'), findsOneWidget);
      expect(find.text('row 9999'), findsNothing);
      expect(find.byType(Text).evaluate().length, lessThan(100));
    });
  });

  group('list lazy (§2.6)', () {
    testWidgets('10 000-item list builds in under a second with only visible '
        'children', (tester) async {
      final items = [for (var i = 0; i < 10000; i++) 'item $i'];
      final stopwatch = Stopwatch()..start();
      await _pumpNode(tester, {'type': 'list', 'items': items});
      stopwatch.stop();
      expect(tester.takeException(), isNull);

      final visible = find.byType(Text).evaluate().length;
      // ignore: avoid_print — the T59 QA script greps this perf line.
      print('T59_PERF list_10000 '
          'build_ms=${stopwatch.elapsedMilliseconds} visible_texts=$visible');
      expect(stopwatch.elapsed, lessThan(const Duration(seconds: 1)));
      expect(visible, lessThan(100));
      expect(find.text('item 0'), findsOneWidget);
      expect(find.text('item 9999'), findsNothing);

      await tester.drag(find.byType(ListView), const Offset(0, -300000));
      await tester.pumpAndSettle();
      expect(find.text('item 9999'), findsOneWidget);
    });

    testWidgets('list separator is inserted between entries', (tester) async {
      await _pumpNode(tester, {
        'type': 'list',
        'items': ['a', 'b', 'c'],
        'separator': {'type': 'text', 'text': '---'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('a'), findsOneWidget);
      expect(find.text('c'), findsOneWidget);
      expect(find.text('---'), findsNWidgets(2));
    });

    testWidgets('list itemExtent fixes the entry extent', (tester) async {
      await _pumpNode(tester, {
        'type': 'list',
        'itemExtent': 40,
        'items': ['a', 'b'],
      });
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.text('a')).height, 40);
      expect(tester.getSize(find.text('b')).height, 40);
    });

    testWidgets('list prototypeItem fixes the entry extent', (tester) async {
      await _pumpNode(tester, {
        'type': 'list',
        'prototypeItem': {'type': 'box', 'height': 30, 'child': {'type': 'text', 'text': 'proto'}},
        'items': ['a', 'b'],
      });
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.text('a')).height, 30);
    });
  });

  group('degradation (§2.4)', () {
    testWidgets('unknown stack literals and unknown props degrade silently',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'stack',
        'fit': 'nope',
        'clipBehavior': 'nope',
        'alignment': 'nope',
        'bogusProp': 42,
        'children': [
          {'type': 'text', 'text': 'ok'},
        ],
      });
      expect(tester.takeException(), isNull);
      expect(find.text('ok'), findsOneWidget);
      final widget = tester.widget<Stack>(
        find.descendant(of: find.byType(_Host), matching: find.byType(Stack)),
      );
      // Unknown enum literals degrade to the documented defaults (§2.4).
      expect(widget.fit, StackFit.loose);
      expect(widget.clipBehavior, Clip.hardEdge);
      expect(widget.alignment, Alignment.topLeft);
    });

    testWidgets('unknown enum literals degrade client-side on wrap, grid and '
        'scroll', (tester) async {
      await _pumpNode(tester, {
        'type': 'wrap',
        'direction': 'nope',
        'alignment': 'nope',
        'runAlignment': 'nope',
        'crossAxisAlignment': 'nope',
        'verticalDirection': 'nope',
        'bogusProp': 1,
        'children': [
          {'type': 'text', 'text': 'w'},
        ],
      });
      expect(tester.takeException(), isNull);
      expect(find.text('w'), findsOneWidget);
      expect(tester.widget<Wrap>(find.byType(Wrap)).direction, Axis.horizontal);

      await _pumpNode(tester, {
        'type': 'grid',
        'columns': 1,
        'physics': 'nope',
        'childAspectRatio': 'nope',
        'children': [
          {'type': 'text', 'text': 'g'},
        ],
      });
      expect(tester.takeException(), isNull);
      expect(find.text('g'), findsOneWidget);

      await _pumpNode(tester, {
        'type': 'scroll',
        'scrollDirection': 'nope',
        'physics': 'nope',
        'reverse': 'nope',
        'children': [
          {'type': 'text', 'text': 's'},
        ],
      });
      expect(tester.takeException(), isNull);
      expect(find.text('s'), findsOneWidget);
    });
  });
}
