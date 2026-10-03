import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/primitives/figure.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';

/// 1×1 red PNG, for `image.dataUri` rendering.
const String _pixelPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

Future<void> _pumpNode(WidgetTester tester, Object? json) async {
  final ctx = testRenderContext(UiState());
  final node = UiNode.fromJson(json);
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(body: Builder(builder: (context) => ctx.build(context, node))),
  ));
  await tester.pump();
}

bool _isSizedContainer(Widget widget, double width, double height) =>
    widget is Container &&
    widget.constraints == BoxConstraints.tightFor(width: width, height: height);

void main() {
  group('PrimitivesBatch2Test', () {
    testWidgets('list renders string and node items and scrolls lazily under '
        'maxHeight', (tester) async {
      await _pumpNode(tester, {
        'type': 'list',
        'items': ['one', {'type': 'text', 'text': 'two'}],
      });

      expect(find.text('one'), findsOneWidget);
      expect(find.text('two'), findsOneWidget);
      expect(find.byType(ListView), findsOneWidget);
      expect(find.byType(SingleChildScrollView), findsNothing);

      await _pumpNode(tester, {
        'type': 'list',
        'maxHeight': 50,
        'items': ['scrolled'],
      });

      expect(find.text('scrolled'), findsOneWidget);
      expect(find.byType(ListView), findsOneWidget);
      expect(tester.getSize(find.byType(ListView)).height, 50);
    });

    testWidgets('table renders headers and cells honouring width flex',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'table',
        'columns': [
          {'label': 'Name', 'width': 2},
          {'label': 'Value'},
        ],
        'rows': [
          ['a', {'type': 'text', 'text': 'b'}],
        ],
      });

      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Value'), findsOneWidget);
      expect(find.text('a'), findsOneWidget);
      expect(find.text('b'), findsOneWidget);
      final flexes = tester
          .widgetList<Expanded>(find.byType(Expanded))
          .map((widget) => widget.flex)
          .toList();
      expect(flexes, [2, 1, 2, 1]);
    });

    testWidgets('progress renders linear by default and circular on request',
        (tester) async {
      await _pumpNode(tester, {'type': 'progress', 'value': 0.25});

      final linear = tester.widget<LinearProgressIndicator>(
          find.byType(LinearProgressIndicator));
      expect(linear.value, 0.25);

      await _pumpNode(tester,
          {'type': 'progress', 'kind': 'circular', 'value': 0.5});

      final circular = tester
          .widget<CircularProgressIndicator>(find.byType(CircularProgressIndicator));
      expect(circular.value, 0.5);
    });

    testWidgets('image renders a dataUri with width, height and fit',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'image',
        'dataUri': _pixelPng,
        'width': 16,
        'height': 8,
        'fit': 'cover',
      });

      expect(tester.takeException(), isNull);
      final image = tester.widget<Image>(find.byType(Image));
      expect(image.width, 16);
      expect(image.height, 8);
      expect(image.fit, BoxFit.cover);
    });

    testWidgets('figure renders rectangle, circle and triangle', (tester) async {
      await _pumpNode(tester, {
        'type': 'figure',
        'shape': 'rectangle',
        'color': '#FF0000',
        'width': 32,
        'height': 16,
      });

      expect(find.byWidgetPredicate((widget) => _isSizedContainer(widget, 32, 16)),
          findsOneWidget);

      await _pumpNode(tester, {
        'type': 'figure',
        'shape': 'circle',
        'color': '#00FF00',
        'width': 24,
        'height': 24,
      });

      final circle = tester.widget<Container>(find.byType(Container));
      expect(circle.decoration, isA<BoxDecoration>());
      expect((circle.decoration! as BoxDecoration).shape, BoxShape.circle);

      await _pumpNode(tester, {
        'type': 'figure',
        'shape': 'triangle',
        'color': '#0000FF',
        'width': 32,
        'height': 32,
      });

      expect(
          find.byWidgetPredicate((widget) =>
              widget is CustomPaint && widget.painter is FigureTrianglePainter),
          findsOneWidget);
    });

    testWidgets('drawer renders its title and children', (tester) async {
      await _pumpNode(tester, {
        'type': 'drawer',
        'title': 'Menu',
        'children': [
          {'type': 'text', 'text': 'item'},
        ],
      });

      expect(find.text('Menu'), findsOneWidget);
      expect(find.text('item'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('PrimitivesBatch2FailureTest', () {
    // Per-type visible fallbacks for `{}` props (the node degrade rule).
    final fallbacks = <String, Finder Function()>{
      'list': () => find.text('Missing items'),
      'table': () => find.text('Missing columns'),
      'stream_view': () => find.text('Missing topic'),
      'progress': () => find.byType(LinearProgressIndicator),
      'image': () => find.text('Missing src'),
      'figure': () => find.byWidgetPredicate(
          (widget) => _isSizedContainer(widget, 64, 64)),
      'chart_line': () => find.text('Missing series'),
      'chart_bar': () => find.text('Missing items'),
      'chart_pie': () => find.text('Missing items'),
      'drawer': () => find.text('Missing children'),
    };

    for (final entry in fallbacks.entries) {
      testWidgets('${entry.key} with empty props degrades to a visible '
          'fallback without throwing', (tester) async {
        await _pumpNode(tester, {'type': entry.key});

        expect(tester.takeException(), isNull);
        expect(entry.value(), findsOneWidget);
      });
    }

    testWidgets('malformed props degrade only their node, never the screen',
        (tester) async {
      await _pumpNode(tester, {
        'type': 'container',
        'children': [
          {'type': 'table', 'columns': 'oops', 'rows': 42},
          {'type': 'chart_pie', 'items': 7},
          {'type': 'list', 'items': {}},
          {'type': 'stream_view', 'topic': 123},
          {'type': 'text', 'text': 'survivor'},
        ],
      });

      expect(tester.takeException(), isNull);
      expect(find.text('survivor'), findsOneWidget);
      expect(find.text('Missing columns'), findsOneWidget);
      expect(find.text('Missing topic'), findsOneWidget);
      expect(find.text('Missing items'), findsNWidgets(2));
    });
  });
}
