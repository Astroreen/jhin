import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'ui_harness.dart';

void main() {
  testWidgets('button tap → onAction с payload', (tester) async {
    final calls = <(String, Map<String, dynamic>?)>[];
    await pumpUi(
      tester,
      {
        'type': 'button',
        'label': 'Save',
        'action': 'save',
        'payload': {'id': 1, 'name': 'x'},
        'style': 'primary',
      },
      ctx: testCtx(onAction: (a, p) => calls.add((a, p))),
    );
    await tester.tap(find.text('Save'));
    await tester.pump();
    expect(calls, hasLength(1));
    expect(calls.single.$1, 'save');
    expect(calls.single.$2, {'id': 1, 'name': 'x'});
  });

  testWidgets('button без action → disabled, onAction не зовётся',
      (tester) async {
    final calls = <(String, Map<String, dynamic>?)>[];
    await pumpUi(
      tester,
      {'type': 'button', 'label': 'Noop'},
      ctx: testCtx(onAction: (a, p) => calls.add((a, p))),
    );
    final button = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Noop'),
    );
    expect(button.onPressed, isNull);
    await tester.tap(find.text('Noop'), warnIfMissed: false);
    await tester.pump();
    expect(calls, isEmpty);
  });

  testWidgets('button с action и style primary → ElevatedButton enabled',
      (tester) async {
    await pumpUi(tester, {
      'type': 'button',
      'label': 'Go',
      'action': 'go',
      'style': 'primary',
    });
    final button = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Go'),
    );
    expect(button.onPressed, isNotNull);
  });

  testWidgets('dropdown выбор → onAction с {"value": ...}', (tester) async {
    final calls = <(String, Map<String, dynamic>?)>[];
    await pumpUi(
      tester,
      {
        'type': 'dropdown',
        'items': [
          {'label': 'Alpha', 'value': 'a'},
          {'label': 'Beta', 'value': 'b'},
        ],
        'value': 'a',
        'action': 'pick',
      },
      ctx: testCtx(onAction: (a, p) => calls.add((a, p))),
    );
    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Beta').last);
    await tester.pumpAndSettle();

    expect(calls, hasLength(1));
    expect(calls.single.$1, 'pick');
    expect(calls.single.$2, {'value': 'b'});
  });

  testWidgets('dropdown: выбор сохраняет значение в виджете', (tester) async {
    await pumpUi(
      tester,
      {
        'type': 'dropdown',
        'items': [
          {'label': 'Alpha', 'value': 'a'},
          {'label': 'Beta', 'value': 'b'},
        ],
        'action': 'pick',
      },
    );
    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Beta').last);
    await tester.pumpAndSettle();
    expect(find.text('Beta'), findsOneWidget);
  });

  testWidgets('form submit собирает значения всех полей', (tester) async {
    final calls = <(String, Map<String, dynamic>?)>[];
    await pumpUi(
      tester,
      {
        'type': 'form',
        'fields': [
          {
            'kind': 'textfield',
            'name': 'title',
            'label': 'Title',
            'value': 'initial',
          },
          {
            'kind': 'checkbox',
            'name': 'agree',
            'label': 'Agree',
            'value': true,
          },
          {
            'kind': 'switch',
            'name': 'dark',
            'label': 'Dark',
            'value': false,
          },
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
      },
      ctx: testCtx(onAction: (a, p) => calls.add((a, p))),
    );

    await tester.enterText(find.byType(TextField), 'typed');
    await tester.tap(find.text('Agree'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dark'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pump();

    expect(calls, hasLength(1));
    expect(calls.single.$1, 'apply');
    final payload = calls.single.$2!;
    expect(payload['title'], 'typed');
    expect(payload['agree'], false);
    expect(payload['dark'], true);
    expect(payload['level'], 30);
  });

  testWidgets('form submit без правок → начальные значения полей',
      (tester) async {
    final calls = <(String, Map<String, dynamic>?)>[];
    await pumpUi(
      tester,
      {
        'type': 'form',
        'fields': [
          {'kind': 'textfield', 'name': 'a', 'label': 'A', 'value': 'v'},
          {'kind': 'checkbox', 'name': 'b', 'label': 'B', 'value': true},
          {'kind': 'switch', 'name': 'c', 'label': 'C', 'value': true},
          {
            'kind': 'slider',
            'name': 'd',
            'label': 'D',
            'min': 0,
            'max': 10,
            'value': 7.5,
          },
        ],
        'submit': {'label': 'Go', 'action': 'go'},
      },
      ctx: testCtx(onAction: (a, p) => calls.add((a, p))),
    );
    await tester.tap(find.text('Go'));
    await tester.pump();
    expect(calls.single.$2, {
      'a': 'v',
      'b': true,
      'c': true,
      'd': 7.5,
    });
  });

  testWidgets('form: кривые/неизвестные поля пропускаются', (tester) async {
    final calls = <(String, Map<String, dynamic>?)>[];
    await pumpUi(
      tester,
      {
        'type': 'form',
        'fields': [
          {'kind': 'mystery', 'name': 'x'},
          {'kind': 'textfield'},
          42,
          {'kind': 'textfield', 'name': 'ok', 'label': 'OK', 'value': 'yes'},
        ],
        'submit': {'label': 'Send', 'action': 'send'},
      },
      ctx: testCtx(onAction: (a, p) => calls.add((a, p))),
    );
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('Send'));
    await tester.pump();
    expect(calls.single.$2, {'ok': 'yes'});
  });

  testWidgets('form без submit → без кнопки', (tester) async {
    await pumpUi(tester, {
      'type': 'form',
      'fields': [
        {'kind': 'textfield', 'name': 'a', 'label': 'A'},
      ],
    });
    expect(find.byType(ElevatedButton), findsNothing);
    expect(find.text('A'), findsOneWidget);
  });
}
