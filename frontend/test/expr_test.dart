import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/expr.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'sdui_fakes.dart';

void main() {
  late UiState state;

  setUp(() {
    state = UiState();
    state.setValue('flag', true);
    state.setValue('off', false);
    state.setValue('count', 5);
    state.setValue('ratio', 1.5);
    state.setValue('name', 'jhin');
  });

  group('ExprTest', () {
    test('when evaluates field references, literals and operators', () {
      expect(evalWhen('flag', state), isTrue);
      expect(evalWhen('!off', state), isTrue);
      expect(evalWhen('!flag', state), isFalse);
      expect(evalWhen('true', state), isTrue);
      expect(evalWhen('false', state), isFalse);
      expect(evalWhen('count == 5', state), isTrue);
      expect(evalWhen('count != 5', state), isFalse);
      expect(evalWhen('count > 3', state), isTrue);
      expect(evalWhen('count >= 5', state), isTrue);
      expect(evalWhen('count < 3', state), isFalse);
      expect(evalWhen('count <= 4', state), isFalse);
      expect(evalWhen('ratio > 1', state), isTrue);
      expect(evalWhen('name == "jhin"', state), isTrue);
      expect(evalWhen("name != 'other'", state), isTrue);
      expect(evalWhen('count > 3 && flag', state), isTrue);
      expect(evalWhen('count < 3 || flag', state), isTrue);
      expect(evalWhen('count < 3 || off', state), isFalse);
      expect(evalWhen('(count < 3 || flag) && !off', state), isTrue);
      expect(evalWhen('!(count > 3)', state), isFalse);
    });

    test('when degrades silently on parse or evaluation failure', () {
      expect(evalWhen('count + 1', state), isNull);
      expect(evalWhen('now()', state), isNull);
      expect(evalWhen('name.method()', state), isNull);
      expect(evalWhen('missing', state), isNull);
      expect(evalWhen('missing == 1', state), isNull);
      expect(evalWhen('count > name', state), isNull);
      expect(evalWhen('count && flag', state), isNull);
      expect(evalWhen('(flag', state), isNull);
      expect(evalWhen('', state), isNull);
      expect(evalWhen('"just a string"', state), isNull);
    });

    test('interpolate fills dollar-brace fragments over the state', () {
      expect(interpolate('hello \${name}!', state), 'hello jhin!');
      expect(interpolate('\${count}', state), '5');
      expect(interpolate('\${count > 3}', state), 'true');
      expect(interpolate('\${ratio}', state), '1.5');
      expect(interpolate('\${name}-\${name}', state), 'jhin-jhin');
      expect(interpolate('no variables', state), 'no variables');
    });

    test('interpolate shows the literal text on failure, never throws', () {
      expect(interpolate('bad \${1 + 2}', state), 'bad \${1 + 2}');
      expect(interpolate('bad \${missing}', state), 'bad \${missing}');
      expect(interpolate('bad \${now()}', state), 'bad \${now()}');
      expect(interpolate('mixed \${name} and \${1 +}', state),
          'mixed jhin and \${1 +}');
      expect(interpolate('unclosed \${name', state), 'unclosed \${name');
    });

    testWidgets('when hides a node when false and shows it when true',
        (tester) async {
      final registry = UiRegistry.standard();
      final ctx = testRenderContext(state);
      Future<void> pumpWhen(String? expression) async {
        await tester.pumpWidget(MaterialApp(
          home: Builder(
            builder: (context) => registry.build(
                context,
                UiNode.fromJson({
                  'type': 'text',
                  'text': 'target',
                  'when': ?expression,
                }),
                ctx),
          ),
        ));
      }

      await pumpWhen('flag');
      expect(find.text('target'), findsOneWidget);

      await pumpWhen('off');
      expect(find.text('target'), findsNothing);

      await pumpWhen('count > 100');
      expect(find.text('target'), findsNothing);
    });

    testWidgets('unparsable when keeps the node visible and never throws',
        (tester) async {
      final registry = UiRegistry.standard();
      final ctx = testRenderContext(state);
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => registry.build(
              context,
              UiNode.fromJson({
                'type': 'text',
                'text': 'target',
                'when': 'count + 1',
              }),
              ctx),
        ),
      ));
      expect(find.text('target'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('dollar-brace interpolates rendered string props',
        (tester) async {
      final registry = UiRegistry.standard();
      final ctx = testRenderContext(state);
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => registry.build(
              context,
              UiNode.fromJson({'type': 'text', 'text': 'hello \${name}!'}),
              ctx),
        ),
      ));
      expect(find.text('hello jhin!'), findsOneWidget);
    });

    testWidgets(
        'unparsable dollar-brace shows the literal text and never throws',
        (tester) async {
      final registry = UiRegistry.standard();
      final ctx = testRenderContext(state);
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => registry.build(
              context,
              UiNode.fromJson({'type': 'text', 'text': 'bad \${1 + 2}'}),
              ctx),
        ),
      ));
      expect(find.text('bad \${1 + 2}'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
