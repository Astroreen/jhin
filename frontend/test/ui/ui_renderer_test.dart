import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:jhin/ui/primitives/primitive_helpers.dart';
import 'package:jhin/ui/primitives/text_primitive.dart';
import 'package:jhin/ui/renderer/ui_renderer.dart';
import 'package:jhin/ui/ui_registry.dart';

import 'ui_harness.dart';

/// Демо-JSON со всеми примитивами сразу.
final Map<String, dynamic> demoJson = {
  'type': 'container',
  'direction': 'column',
  'gap': 8,
  'children': [
    {'type': 'text', 'text': 'Hello', 'style': 'h1'},
    {
      'type': 'card',
      'title': 'Card title',
      'children': [
        {'type': 'text', 'text': 'Inside card'},
      ],
    },
    {'type': 'button', 'label': 'Go', 'action': 'go', 'style': 'primary'},
    {
      'type': 'dropdown',
      'items': [
        {'label': 'Alpha', 'value': 'a'},
      ],
      'value': 'a',
      'action': 'pick',
    },
    {
      'type': 'list',
      'items': [
        'row one',
        {'type': 'text', 'text': 'row two'},
      ],
    },
    {
      'type': 'drawer',
      'title': 'Panel',
      'children': [
        {'type': 'text', 'text': 'In drawer'},
      ],
    },
    {
      'type': 'form',
      'fields': [
        {'kind': 'textfield', 'name': 'f', 'label': 'Field', 'value': 'v'},
        {'kind': 'checkbox', 'name': 'c', 'label': 'Check'},
        {'kind': 'switch', 'name': 's', 'label': 'Toggle'},
        {
          'kind': 'slider',
          'name': 'r',
          'label': 'Range',
          'min': 0,
          'max': 10,
          'value': 5,
        },
      ],
      'submit': {'label': 'Send', 'action': 'send'},
    },
    {
      'type': 'chart_line',
      'series': [
        {
          'name': 'line',
          'points': [
            {'x': 0, 'y': 1},
            {'x': 1, 'y': 2},
          ],
        },
      ],
    },
    {
      'type': 'chart_bar',
      'items': [
        {'label': 'Bar', 'value': 4},
      ],
    },
    {
      'type': 'chart_pie',
      'items': [
        {'label': 'Pie', 'value': 1, 'color': '#123456'},
      ],
    },
    {'type': 'figure', 'shape': 'triangle', 'width': 50, 'height': 50},
    {
      'type': 'table',
      'columns': [
        {'label': 'Col'},
      ],
      'rows': [
        ['cell'],
      ],
    },
    {'type': 'markdown', 'text': '**md** content'},
    {'type': 'gadget', 'extra': true},
  ],
};

void main() {
  testWidgets('demo: все примитивы рендерятся без падений', (tester) async {
    await pumpUi(tester, demoJson);

    expect(tester.takeException(), isNull);
    expect(find.text('Hello'), findsOneWidget);
    expect(find.text('Card title'), findsOneWidget);
    expect(find.text('Inside card'), findsOneWidget);
    expect(find.text('Go'), findsOneWidget);
    expect(find.text('Alpha'), findsOneWidget);
    expect(find.text('row one'), findsOneWidget);
    expect(find.text('row two'), findsOneWidget);
    expect(find.text('Panel'), findsOneWidget);
    expect(find.text('In drawer'), findsOneWidget);
    expect(find.text('Field'), findsOneWidget);
    expect(find.text('Send'), findsOneWidget);
    expect(find.byType(LineChart), findsOneWidget);
    expect(find.byType(BarChart), findsOneWidget);
    expect(find.byType(PieChart), findsOneWidget);
    expect(find.text('Col'), findsOneWidget);
    expect(find.text('cell'), findsOneWidget);
    expect(find.text('Unsupported UI element: gadget'), findsOneWidget);
  });

  testWidgets('рекурсия children: container > card > container > text',
      (tester) async {
    await pumpUi(tester, {
      'type': 'container',
      'children': [
        {
          'type': 'card',
          'title': 'Outer',
          'children': [
            {
              'type': 'container',
              'direction': 'row',
              'children': [
                {'type': 'text', 'text': 'deep'},
                {'type': 'text', 'text': 'deeper'},
              ],
            },
          ],
        },
      ],
    });
    expect(find.text('Outer'), findsOneWidget);
    expect(find.text('deep'), findsOneWidget);
    expect(find.text('deeper'), findsOneWidget);
  });

  testWidgets('кривые поля не роняют рендер', (tester) async {
    await pumpUi(tester, {
      'type': 'container',
      'children': [
        {'type': 'text'},
        {'type': 'text', 'text': 'ok'},
        {'type': 'button'},
        {'type': 'button', 'label': 'B', 'action': 42, 'payload': 'oops'},
        {
          'type': 'dropdown',
          'items': [
            {'label': 'no value'},
            'broken',
            {'label': 'ok', 'value': 'v'},
          ],
        },
        {'type': 'dropdown', 'items': 'not-a-list'},
        {'type': 'list', 'items': [null, 42, {'type': 'text', 'text': 'row'}]},
        {'type': 'drawer'},
        {'type': 'form', 'fields': 'nope', 'submit': 42},
        {'type': 'chart_line', 'series': 'garbage'},
        {
          'type': 'chart_line',
          'series': [
            {
              'points': [
                {'x': 'a', 'y': null},
              ],
            },
          ],
        },
        {'type': 'chart_bar', 'items': 'garbage'},
        {'type': 'chart_pie', 'items': [
          {'label': 'neg', 'value': -1},
        ]},
        {'type': 'figure', 'shape': 'blob', 'width': 'huge', 'height': null},
        {'type': 'table', 'columns': 'garbage'},
        {
          'type': 'table',
          'columns': [
            {'label': 'A'},
            {'label': 'B'},
          ],
          'rows': [
            ['only-one'],
            ['x', 'y', 'extra'],
            'not-a-row',
          ],
        },
        {'type': 'markdown', 'text': 42},
        {'type': 'no-such-type'},
      ],
    });
    expect(tester.takeException(), isNull);
    expect(find.text('ok'), findsOneWidget);
    expect(find.text('row'), findsOneWidget);
    expect(find.text('Empty table'), findsOneWidget);
    expect(find.text('No chart data'), findsNWidgets(4));
  });

  testWidgets('unknown type: заглушка с именем типа', (tester) async {
    await pumpUi(tester, {'type': 'mystery_widget', 'foo': 1});
    expect(find.text('Unsupported UI element: mystery_widget'), findsOneWidget);
  });

  test('defaultUiRegistry: все 14 примитивов + supportedPrimitives', () {
    final types = defaultUiRegistry.supportedPrimitives();
    expect(types, containsAll(<String>[
      'container',
      'card',
      'text',
      'button',
      'dropdown',
      'list',
      'drawer',
      'form',
      'chart_line',
      'chart_bar',
      'chart_pie',
      'figure',
      'table',
      'markdown',
    ]));
    expect(types, hasLength(14));
    expect(defaultUiRegistry.supports('text'), isTrue);
    expect(defaultUiRegistry.supports('gadget'), isFalse);
  });

  testWidgets('кастомный UiRegistry: своя регистрация + заглушка',
      (tester) async {
    final registry = UiRegistry()
      ..register('text', buildText)
      ..register(
        'box',
        (json, ctx) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: buildChildWidgets(json['children'], ctx),
        ),
      );
    final ctx = testCtx().withRegistry(registry);

    await pumpUi(
      tester,
      {
        'type': 'box',
        'children': [
          {'type': 'text', 'text': 'custom'},
        ],
      },
      ctx: ctx,
    );
    expect(find.text('custom'), findsOneWidget);

    await pumpUi(tester, {'type': 'container'}, ctx: ctx);
    expect(find.text('Unsupported UI element: container'), findsOneWidget);
    expect(registry.supportedPrimitives(), ['text', 'box']);
  });
}
