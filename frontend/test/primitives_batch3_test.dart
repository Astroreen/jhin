import 'package:flutter/material.dart' hide ActionDispatcher;
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T58 — `box` decoration parity and `row`/`column`/`flex` alignment parity
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

/// The absolute y of the alphabetic baseline of the rendered text [value].
/// `getDistanceToBaseline` asserts when queried outside layout, so the query
/// runs under `debugCheckingIntrinsics` (the same short-circuit the
/// framework's own intrinsic probes use) — the value is the real baseline.
double _baselineY(WidgetTester tester, String value) {
  final paragraph = tester.renderObject<RenderParagraph>(find.text(value));
  RenderObject.debugCheckingIntrinsics = true;
  final double distance;
  try {
    distance = paragraph.getDistanceToBaseline(TextBaseline.alphabetic)!;
  } finally {
    RenderObject.debugCheckingIntrinsics = false;
  }
  return paragraph.localToGlobal(Offset(0, distance)).dy;
}

void main() {
  group('box decoration (§2.6 / §2.3 step 3)', () {
    testWidgets('gradient + border + radius + shadow produce a DecoratedBox '
        'chain', (tester) async {
      await _pumpNode(tester, {
        'type': 'box',
        'color': '#112233',
        'gradient': {
          'type': 'linear',
          'colors': ['#ff0000', '#0000ff'],
          'begin': 'topLeft',
          'end': 'bottomRight',
        },
        'border': '#00ff00',
        'borderWidth': 2,
        'borderStyle': 'solid',
        'borderRadius': 8,
        'shadow': {
          'color': '#000000',
          'blur': 12,
          'spread': 0,
          'offset': [0, 4],
        },
        'child': {'type': 'text', 'text': 'deco'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('deco'), findsOneWidget);
      final decorated = find.ancestor(
        of: find.text('deco'),
        matching: find.byType(DecoratedBox),
      );
      expect(decorated, findsOneWidget);
      final decoration =
          tester.widget<DecoratedBox>(decorated).decoration as BoxDecoration;
      expect(decoration.color, const Color(0xFF112233));
      expect(decoration.gradient, isA<LinearGradient>());
      expect(decoration.border, isNotNull);
      expect(decoration.borderRadius, BorderRadius.circular(8));
      expect(decoration.boxShadow, hasLength(1));
    });

    testWidgets('shape circle drops the radius instead of asserting',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'box',
        'shape': 'circle',
        'color': '#112233',
        'borderRadius': 8,
        'child': {'type': 'text', 'text': 'round'},
      });
      expect(tester.takeException(), isNull);
      final decorated = find.ancestor(
        of: find.text('round'),
        matching: find.byType(DecoratedBox),
      );
      expect(decorated, findsOneWidget);
      final decoration =
          tester.widget<DecoratedBox>(decorated).decoration as BoxDecoration;
      expect(decoration.shape, BoxShape.circle);
      expect(decoration.borderRadius, isNull);
    });
  });

  group('flex baseline alignment (§2.1 Flex group)', () {
    testWidgets('row crossAxisAlignment baseline aligns child baselines',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'row',
        'crossAxisAlignment': 'baseline',
        'textBaseline': 'alphabetic',
        'children': [
          {'type': 'text', 'text': 'small', 'fontSize': 12},
          {'type': 'text', 'text': 'LARGE', 'fontSize': 28},
        ],
      });
      expect(tester.takeException(), isNull);
      final flex = tester.widget<Flex>(find.byType(Flex));
      expect(flex.crossAxisAlignment, CrossAxisAlignment.baseline);
      expect(flex.textBaseline, TextBaseline.alphabetic);
      expect(_baselineY(tester, 'small'), _baselineY(tester, 'LARGE'));
    });

    testWidgets('row baseline without textBaseline still renders (default '
        'applied)', (tester) async {
      await _pumpNode(tester, {
        'type': 'row',
        'crossAxisAlignment': 'baseline',
        'children': [
          {'type': 'text', 'text': 'a', 'fontSize': 12},
          {'type': 'text', 'text': 'b', 'fontSize': 24},
        ],
      });
      expect(tester.takeException(), isNull);
      final flex = tester.widget<Flex>(find.byType(Flex));
      expect(flex.crossAxisAlignment, CrossAxisAlignment.baseline);
      expect(flex.textBaseline, TextBaseline.alphabetic);
    });

    testWidgets('column crossAxisAlignment baseline renders without crashing',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'column',
        'crossAxisAlignment': 'baseline',
        'children': [
          {'type': 'text', 'text': 'top', 'fontSize': 12},
          {'type': 'text', 'text': 'bottom', 'fontSize': 24},
        ],
      });
      expect(tester.takeException(), isNull);
      final flex = tester.widget<Flex>(find.byType(Flex));
      expect(flex.crossAxisAlignment, CrossAxisAlignment.baseline);
    });
  });

  group('enum acceptance matrix (every documented literal renders)', () {
    Future<void> pumpRow(
        WidgetTester tester, String prop, String literal) async {
      await _pumpNode(tester, {
        'type': 'row',
        prop: literal,
        'children': [
          {'type': 'text', 'text': 'a'},
          {'type': 'text', 'text': 'b'},
        ],
      });
      expect(tester.takeException(), isNull, reason: '$prop: $literal');
      expect(find.text('a'), findsOneWidget);
    }

    testWidgets('mainAxisAlignment literals', (tester) async {
      for (final literal in const [
        'start',
        'end',
        'center',
        'spaceBetween',
        'spaceAround',
        'spaceEvenly',
      ]) {
        await pumpRow(tester, 'mainAxisAlignment', literal);
      }
    });

    testWidgets('crossAxisAlignment literals', (tester) async {
      for (final literal in const [
        'start',
        'end',
        'center',
        'stretch',
        'baseline',
      ]) {
        await pumpRow(tester, 'crossAxisAlignment', literal);
      }
    });

    testWidgets('mainAxisSize / textDirection / verticalDirection / '
        'textBaseline literals', (tester) async {
      for (final literal in const ['min', 'max']) {
        await pumpRow(tester, 'mainAxisSize', literal);
      }
      for (final literal in const ['ltr', 'rtl']) {
        await pumpRow(tester, 'textDirection', literal);
      }
      for (final literal in const ['up', 'down']) {
        await pumpRow(tester, 'verticalDirection', literal);
      }
      for (final literal in const ['alphabetic', 'ideographic']) {
        await pumpRow(tester, 'textBaseline', literal);
      }
    });

    testWidgets('clipBehavior and overflow literals', (tester) async {
      for (final literal in const [
        'none',
        'hardEdge',
        'softEdge',
        'antiAlias',
        'antiAliasWithSaveLayer',
      ]) {
        await pumpRow(tester, 'clipBehavior', literal);
      }
      for (final literal in const ['visible', 'clip', 'fade', 'ellipsis']) {
        await pumpRow(tester, 'overflow', literal);
      }
    });

    testWidgets('direction literals on box and flex', (tester) async {
      for (final literal in const ['row', 'column']) {
        await _pumpNode(tester, {
          'type': 'box',
          'direction': literal,
          'children': [
            {'type': 'text', 'text': 'a'},
            {'type': 'text', 'text': 'b'},
          ],
        });
        expect(tester.takeException(), isNull, reason: 'box direction: $literal');

        await _pumpNode(tester, {
          'type': 'flex',
          'direction': literal,
          'children': [
            {'type': 'text', 'text': 'a'},
            {'type': 'text', 'text': 'b'},
          ],
        });
        expect(tester.takeException(), isNull,
            reason: 'flex direction: $literal');
      }
    });

    testWidgets('box shape literals', (tester) async {
      for (final literal in const ['rectangle', 'circle']) {
        await _pumpNode(tester, {
          'type': 'box',
          'shape': literal,
          'child': {'type': 'text', 'text': 's'},
        });
        expect(tester.takeException(), isNull, reason: 'shape: $literal');
        expect(find.text('s'), findsOneWidget);
      }
    });

    testWidgets('alignment literals on align and box', (tester) async {
      for (final literal in const [
        'topLeft',
        'topCenter',
        'topRight',
        'centerLeft',
        'center',
        'centerRight',
        'bottomLeft',
        'bottomCenter',
        'bottomRight',
      ]) {
        await _pumpNode(tester, {
          'type': 'align',
          'align': literal,
          'child': {'type': 'text', 'text': 'a'},
        });
        expect(tester.takeException(), isNull, reason: 'align: $literal');

        await _pumpNode(tester, {
          'type': 'box',
          'alignment': literal,
          'child': {'type': 'text', 'text': 'a'},
        });
        expect(tester.takeException(), isNull, reason: 'box alignment: $literal');
      }
    });

    testWidgets('flexible fit literals', (tester) async {
      for (final literal in const ['loose', 'tight']) {
        await _pumpNode(tester, {
          'type': 'row',
          'children': [
            {
              'type': 'flexible',
              'fit': literal,
              'child': {'type': 'text', 'text': 'f'},
            },
          ],
        });
        expect(tester.takeException(), isNull, reason: 'fit: $literal');
        expect(find.text('f'), findsOneWidget);
      }
    });
  });

  group('sized_box exact constraints (§2.6)', () {
    testWidgets('width/height apply as exact constraints', (tester) async {
      await _pumpNode(tester, {
        'type': 'sized_box',
        'width': 40,
        'height': 20,
        'child': {'type': 'text', 'text': 'x'},
      });
      expect(tester.takeException(), isNull);
      final sized = find.byWidgetPredicate(
          (widget) => widget is SizedBox && widget.width == 40 && widget.height == 20);
      expect(sized, findsOneWidget);
      expect(tester.getSize(sized), const Size(40, 20));
      expect(find.text('x'), findsOneWidget);
    });
  });

  group('aspect_ratio (§2.6)', () {
    testWidgets('aspectRatio is applied', (tester) async {
      await _pumpNode(tester, {
        'type': 'aspect_ratio',
        'aspectRatio': 2.0,
        'child': {'type': 'text', 'text': 'r'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('r'), findsOneWidget);
      final ratios = tester
          .widgetList<AspectRatio>(find.byType(AspectRatio))
          .map((widget) => widget.aspectRatio)
          .toList();
      expect(ratios, isNotEmpty);
      expect(ratios.every((ratio) => ratio == 2.0), isTrue);
    });

    testWidgets('missing/non-positive ratio degrades to the plain child',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'aspect_ratio',
        'aspectRatio': 0,
        'child': {'type': 'text', 'text': 'plain'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('plain'), findsOneWidget);
      expect(find.byType(AspectRatio), findsNothing);
    });
  });

  group('expanded / flexible under and outside a Flex (§2.6)', () {
    testWidgets('expanded under a row becomes an Expanded ancestor',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'row',
        'children': [
          {
            'type': 'expanded',
            'flex': 2,
            'child': {'type': 'text', 'text': 'e'},
          },
        ],
      });
      expect(tester.takeException(), isNull);
      final expanded = find.ancestor(
        of: find.text('e'),
        matching: find.byType(Expanded),
      );
      expect(expanded, findsOneWidget);
      expect(tester.widget<Expanded>(expanded).flex, 2);
    });

    testWidgets('expanded without a flex prop defaults to flex 1',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'row',
        'children': [
          {
            'type': 'expanded',
            'child': {'type': 'text', 'text': 'd'},
          },
        ],
      });
      expect(tester.takeException(), isNull);
      expect(
        find.ancestor(
          of: find.text('d'),
          matching: find.byType(Expanded),
        ),
        findsOneWidget,
      );
    });

    testWidgets('flexible under a row becomes a Flexible ancestor',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'row',
        'children': [
          {
            'type': 'flexible',
            'child': {'type': 'text', 'text': 'f'},
          },
        ],
      });
      expect(tester.takeException(), isNull);
      final flexible = find.ancestor(
        of: find.text('f'),
        matching: find.byType(Flexible),
      );
      expect(flexible, findsOneWidget);
      expect(tester.widget<Flexible>(flexible).fit, FlexFit.loose);
    });

    testWidgets('expanded without a Flex parent degrades to its child',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'expanded',
        'flex': 1,
        'child': {'type': 'text', 'text': 'orphan'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('orphan'), findsOneWidget);
      expect(find.byType(Expanded), findsNothing);
      expect(find.byType(Flexible), findsNothing);
    });
  });

  group('silent degradation (§2.4 / §9)', () {
    testWidgets('unknown gradient.type degrades to the flat color',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'box',
        'color': '#112233',
        'gradient': {
          'type': 'nope',
          'colors': ['#ff0000', '#0000ff'],
        },
        'child': {'type': 'text', 'text': 'flat'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('flat'), findsOneWidget);
      final decorated = find.ancestor(
        of: find.text('flat'),
        matching: find.byType(DecoratedBox),
      );
      expect(decorated, findsOneWidget);
      final decoration =
          tester.widget<DecoratedBox>(decorated).decoration as BoxDecoration;
      expect(decoration.gradient, isNull);
      expect(decoration.color, const Color(0xFF112233));
    });

    testWidgets('unknown box prop is ignored and the node renders',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'box',
        'bogusProp': 123,
        'unknownNested': {'deeply': 'ignored'},
        'child': {'type': 'text', 'text': 'ok'},
      });
      expect(tester.takeException(), isNull);
      expect(find.text('ok'), findsOneWidget);
    });

    testWidgets('unknown enum literal degrades to the prop default',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'row',
        'mainAxisAlignment': 'nope',
        'crossAxisAlignment': 'nope',
        'children': [
          {'type': 'text', 'text': 'a'},
          {'type': 'text', 'text': 'b'},
        ],
      });
      expect(tester.takeException(), isNull);
      final flex = tester.widget<Flex>(find.byType(Flex));
      expect(flex.mainAxisAlignment, MainAxisAlignment.start);
      expect(flex.crossAxisAlignment, CrossAxisAlignment.start);
    });
  });
}
