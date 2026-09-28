import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/widgets/structured_content.dart';

Future<void> pumpStructured(WidgetTester tester, dynamic structured) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: buildStructured(structured))),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('buildStructured: Map с type → SDUI-рендер', (tester) async {
    await pumpStructured(tester, {
      'type': 'card',
      'title': 'T',
      'children': [
        {'type': 'text', 'text': 'hi'},
      ],
    });
    expect(find.byType(Card), findsOneWidget);
    expect(find.text('T'), findsOneWidget);
    expect(find.text('hi'), findsOneWidget);
    // JSON-фолбэк не использован
    expect(find.textContaining('"type"'), findsNothing);
  });

  testWidgets('buildStructured: не-Map → прежний JSON-вид', (tester) async {
    await pumpStructured(tester, 'plain string');
    expect(find.text('"plain string"'), findsOneWidget);
    expect(find.byType(Card), findsNothing);
  });

  testWidgets('buildStructured: Map без type → JSON-вид', (tester) async {
    await pumpStructured(tester, {'foo': 1});
    expect(find.textContaining('"foo"'), findsOneWidget);
  });

  testWidgets('buildStructured: null → пусто', (tester) async {
    await pumpStructured(tester, null);
    expect(find.byType(SizedBox), findsWidgets);
    expect(find.byType(Text), findsNothing);
  });
}
