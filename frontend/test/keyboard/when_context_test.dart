import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';

void main() {
  group('WhenContext', () {
    test('truth table for every context and its negation', () {
      for (final name in WhenContext.contextNames) {
        final context = WhenContext(isWeb: false, isDesktop: false);

        expect(context.value(name), isFalse, reason: '$name starts false');
        expect(context.evaluate(name), isFalse, reason: '$name starts false');
        expect(context.evaluate('!$name'), isTrue,
            reason: '!$name starts true');

        context.set(name, true);

        expect(context.value(name), isTrue, reason: '$name set true');
        expect(context.evaluate(name), isTrue, reason: '$name set true');
        expect(context.evaluate('!$name'), isFalse,
            reason: '!$name set false');

        context.set(name, false);

        expect(context.evaluate(name), isFalse, reason: '$name reset false');
        expect(context.evaluate('!$name'), isTrue,
            reason: '!$name reset true');
      }
    });

    test('unknown context name evaluates false', () {
      final context = WhenContext();

      expect(context.value('nope'), isFalse);
      expect(context.evaluate('nope'), isFalse);
    });

    test('negation of an unknown name is true (negation of false)', () {
      final context = WhenContext();

      expect(context.evaluate('!nope'), isTrue);
    });

    test('unknown context name writes are ignored', () {
      final context = WhenContext();

      context.set('nope', true);

      expect(context.value('nope'), isFalse);
    });

    test('null expression has no gate and evaluates true', () {
      final context = WhenContext();

      expect(context.evaluate(null), isTrue);
    });

    test('malformed expressions evaluate false and never throw', () {
      final context = WhenContext()..composerFocus = true;

      for (final expression in <String>[
        '',
        '!',
        '&&',
        'a &&',
        'a ||',
        '(composerFocus',
        'composerFocus)',
        '== 1',
        'composerFocus != x',
        '@',
      ]) {
        expect(context.evaluate(expression), isFalse,
            reason: '"$expression" must degrade to false');
      }
    });

    test('&& and || combinations (§7 grammar)', () {
      final context = WhenContext();

      expect(context.evaluate('composerFocus && turnRunning'), isFalse);
      expect(context.evaluate('composerFocus || turnRunning'), isFalse);

      context.composerFocus = true;

      expect(context.evaluate('composerFocus && turnRunning'), isFalse);
      expect(context.evaluate('composerFocus || turnRunning'), isTrue);

      context.turnRunning = true;

      expect(context.evaluate('composerFocus && turnRunning'), isTrue);
      expect(context.evaluate('composerFocus && !turnRunning'), isFalse);
      expect(context.evaluate('(composerFocus || paletteOpen) && turnRunning'),
          isTrue);
      expect(context.evaluate('!composerFocus && turnRunning'), isFalse);
    });

    test('context changes notify listeners', () {
      final context = WhenContext();
      var notifications = 0;
      context.addListener(() => notifications++);

      context.composerFocus = true;
      expect(notifications, 1);

      context.composerFocus = true;
      expect(notifications, 1, reason: 'no change, no notification');

      context.composerFocus = false;
      context.paletteOpen = true;
      expect(notifications, 3);
    });

    test('platform facts seed isWeb and isDesktop (injectable)', () {
      final web = WhenContext(isWeb: true, isDesktop: false);
      expect(web.isWeb, isTrue);
      expect(web.isDesktop, isFalse);

      final desktop = WhenContext(isWeb: false, isDesktop: true);
      expect(desktop.isWeb, isFalse);
      expect(desktop.isDesktop, isTrue);
    });
  });

  group('WhenContext evidence', () {
    test('truth table (evidence when.txt)', () {
      final context = WhenContext(isWeb: false, isDesktop: false);
      final buffer = StringBuffer()
        ..writeln('T67 when-context truth table (evaluate over WhenContext)')
        ..writeln('context value | evaluate(name) | evaluate(!name) '
            '| evaluate(!name) after set');
      for (final name in WhenContext.contextNames) {
        final before = context.evaluate(name);
        final notBefore = context.evaluate('!$name');
        context.set(name, true);
        final after = context.evaluate(name);
        final notAfter = context.evaluate('!$name');
        context.set(name, false);
        buffer.writeln('$name $before -> $after | !$name $notBefore '
            '-> $notAfter');
        expect(before, isFalse);
        expect(notBefore, isTrue);
        expect(after, isTrue);
        expect(notAfter, isFalse);
      }
      buffer
        ..writeln('unknown name: evaluate(nope) = '
            '${context.evaluate('nope')}')
        ..writeln('unknown negated: evaluate(!nope) = '
            '${context.evaluate('!nope')}')
        ..writeln('null expression: evaluate(null) = '
            '${context.evaluate(null)}');
      // ignore: avoid_print — the T67 QA script tees this matrix.
      print(buffer);
    });
  });
}
