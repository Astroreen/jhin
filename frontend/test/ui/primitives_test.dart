import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fl_chart/fl_chart.dart';

import 'ui_harness.dart';

void main() {
  testWidgets('container: children в column и row', (tester) async {
    await pumpUi(tester, {
      'type': 'container',
      'direction': 'column',
      'padding': 8,
      'gap': 4,
      'children': [
        {'type': 'text', 'text': 'first'},
        {'type': 'text', 'text': 'second'},
      ],
    });
    expect(find.text('first'), findsOneWidget);
    expect(find.text('second'), findsOneWidget);

    await pumpUi(tester, {
      'type': 'container',
      'direction': 'row',
      'children': [
        {'type': 'text', 'text': 'left'},
        {'type': 'text', 'text': 'right'},
      ],
    });
    expect(find.text('left'), findsOneWidget);
    expect(find.text('right'), findsOneWidget);
    expect(find.byType(Row), findsWidgets);
  });

  testWidgets('card: title + children', (tester) async {
    await pumpUi(tester, {
      'type': 'card',
      'title': 'My card',
      'children': [
        {'type': 'text', 'text': 'body'},
      ],
    });
    expect(find.byType(Card), findsOneWidget);
    expect(find.text('My card'), findsOneWidget);
    expect(find.text('body'), findsOneWidget);
  });

  testWidgets('text: styles, bold, color; без text → пустая строка',
      (tester) async {
    await pumpUi(tester, {'type': 'text', 'text': 'Title', 'style': 'h1'});
    final h1 = tester.widget<Text>(find.text('Title'));
    expect(h1.style?.fontSize, 28);

    await pumpUi(tester, {'type': 'text', 'text': 'Cap', 'style': 'caption'});
    expect(tester.widget<Text>(find.text('Cap')).style?.fontSize, 12);

    await pumpUi(tester, {
      'type': 'text',
      'text': 'colored',
      'bold': true,
      'color': '#FF0000',
    });
    final styled = tester.widget<Text>(find.text('colored'));
    expect(styled.style?.fontWeight, FontWeight.bold);
    expect(styled.style?.color, const Color(0xFFFF0000));

    await pumpUi(tester, {'type': 'text'});
    expect(find.text(''), findsWidgets);
  });

  testWidgets('button: label и стили', (tester) async {
    await pumpUi(tester, {
      'type': 'button',
      'label': 'Save',
      'action': 'save',
      'style': 'primary',
    });
    expect(find.widgetWithText(ElevatedButton, 'Save'), findsOneWidget);

    await pumpUi(tester, {
      'type': 'button',
      'label': 'Cancel',
      'action': 'cancel',
    });
    expect(find.widgetWithText(OutlinedButton, 'Cancel'), findsOneWidget);

    await pumpUi(tester, {
      'type': 'button',
      'label': 'Delete',
      'action': 'delete',
      'style': 'danger',
    });
    expect(find.widgetWithText(ElevatedButton, 'Delete'), findsOneWidget);
  });

  testWidgets('dropdown: items и начальное значение', (tester) async {
    await pumpUi(tester, {
      'type': 'dropdown',
      'items': [
        {'label': 'Alpha', 'value': 'a'},
        {'label': 'Beta', 'value': 'b'},
      ],
      'value': 'b',
      'action': 'pick',
    });
    expect(find.byType(DropdownButton<String>), findsOneWidget);
    expect(find.text('Beta'), findsOneWidget);
  });

  testWidgets('list: строки и узлы как items', (tester) async {
    await pumpUi(tester, {
      'type': 'list',
      'items': [
        'plain row',
        {'type': 'text', 'text': 'node row'},
      ],
    });
    expect(find.text('plain row'), findsOneWidget);
    expect(find.text('node row'), findsOneWidget);
    expect(find.byType(ListView), findsOneWidget);
  });

  testWidgets('drawer: заголовок и children', (tester) async {
    await pumpUi(tester, {
      'type': 'drawer',
      'title': 'Panel',
      'children': [
        {'type': 'text', 'text': 'inside'},
      ],
    });
    expect(find.text('Panel'), findsOneWidget);
    expect(find.text('inside'), findsOneWidget);
    expect(find.byIcon(Icons.menu), findsOneWidget);
  });

  testWidgets('form: поля и submit-кнопка', (tester) async {
    await pumpUi(tester, {
      'type': 'form',
      'fields': [
        {
          'kind': 'textfield',
          'name': 'title',
          'label': 'Title',
          'value': 'abc',
        },
        {'kind': 'checkbox', 'name': 'ok', 'label': 'Agree'},
        {'kind': 'switch', 'name': 'dark', 'label': 'Dark mode'},
        {
          'kind': 'slider',
          'name': 'level',
          'label': 'Level',
          'min': 0,
          'max': 100,
          'value': 30,
        },
      ],
      'submit': {'label': 'Apply', 'action': 'apply'},
    });
    expect(find.text('Title'), findsOneWidget);
    expect(find.text('Agree'), findsOneWidget);
    expect(find.text('Dark mode'), findsOneWidget);
    expect(find.text('Level: 30'), findsOneWidget);
    expect(find.widgetWithText(ElevatedButton, 'Apply'), findsOneWidget);
  });

  testWidgets('chart_line: LineChart с серией', (tester) async {
    await pumpUi(tester, {
      'type': 'chart_line',
      'series': [
        {
          'name': 'load',
          'points': [
            {'x': 0, 'y': 1},
            {'x': 1, 'y': 3},
          ],
        },
      ],
    });
    expect(find.byType(LineChart), findsOneWidget);
    expect(find.text('load'), findsOneWidget);
  });

  testWidgets('chart_bar: items и series', (tester) async {
    await pumpUi(tester, {
      'type': 'chart_bar',
      'items': [
        {'label': 'Q1', 'value': 3},
        {'label': 'Q2', 'value': 5},
      ],
    });
    expect(find.byType(BarChart), findsOneWidget);
    expect(find.text('Q1'), findsOneWidget);

    await pumpUi(tester, {
      'type': 'chart_bar',
      'series': [
        {
          'name': 'a',
          'values': [
            {'label': 'X', 'value': 1},
          ],
        },
        {
          'name': 'b',
          'values': [
            {'label': 'X', 'value': 2},
          ],
        },
      ],
    });
    expect(find.byType(BarChart), findsOneWidget);
    expect(find.text('a'), findsOneWidget);
    expect(find.text('b'), findsOneWidget);
  });

  testWidgets('chart_pie: PieChart и легенда', (tester) async {
    await pumpUi(tester, {
      'type': 'chart_pie',
      'items': [
        {'label': 'Apples', 'value': 3, 'color': '#FF0000'},
        {'label': 'Pears', 'value': 2},
      ],
    });
    expect(find.byType(PieChart), findsOneWidget);
    expect(find.text('Apples'), findsWidgets);
    expect(find.text('Pears'), findsWidgets);
  });

  testWidgets('figure: rectangle/circle/triangle', (tester) async {
    for (final shape in ['rectangle', 'circle', 'triangle']) {
      await pumpUi(tester, {
        'type': 'figure',
        'shape': shape,
        'width': 40,
        'height': 30,
        'color': '#00FF00',
      });
      expect(find.byType(CustomPaint), findsWidgets);
    }
  });

  testWidgets('table: колонки и ячейки', (tester) async {
    await pumpUi(tester, {
      'type': 'table',
      'columns': [
        {'label': 'Name'},
        {'label': 'Count'},
      ],
      'rows': [
        ['apples', 3],
        ['pears', 5],
      ],
    });
    expect(find.text('Name'), findsOneWidget);
    expect(find.text('Count'), findsOneWidget);
    expect(find.text('apples'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
  });

  testWidgets('markdown: рендерит текст', (tester) async {
    await pumpUi(tester, {
      'type': 'markdown',
      'text': '# Hello\n\nSome **bold** text',
    });
    expect(find.text('Hello'), findsOneWidget);
    expect(find.textContaining('bold'), findsOneWidget);
  });

  testWidgets('unknown type → карточка-заглушка', (tester) async {
    await pumpUi(tester, {'type': 'gadget'});
    expect(find.text('Unsupported UI element: gadget'), findsOneWidget);
    expect(find.byIcon(Icons.help_outline), findsOneWidget);
  });

  testWidgets('text: кривые поля не роняют', (tester) async {
    await pumpUi(tester, {
      'type': 'text',
      'text': 42,
      'style': 'mega',
      'bold': 'yes',
      'color': 'not-a-color',
    });
    expect(tester.takeException(), isNull);
    expect(find.text(''), findsWidgets);
  });
}
