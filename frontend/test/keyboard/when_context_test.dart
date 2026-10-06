import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';

/// One row of the T116 when-context truth table: an expression, the context
/// setup it is evaluated against and the expected result.
class _Row {
  const _Row(this.expression, this.expected, [this.setup]);

  final String expression;
  final bool expected;
  final void Function(WhenContext)? setup;
}

void main() {
  group('WhenContext', () {
    test('20-row when-context truth table', () {
      final rows = <_Row>[
        _Row('terminalFocus', false),
        _Row('terminalFocus', true, (c) => c.terminalFocus = true),
        _Row('!terminalFocus', true),
        _Row('terminalOpen', true, (c) => c.terminalOpen = true),
        _Row('previewFocus', true, (c) => c.previewFocus = true),
        _Row('previewOpen', true, (c) => c.previewOpen = true),
        _Row('modelPickerOpen', true, (c) => c.modelPickerOpen = true),
        _Row('usagePageOpen', true, (c) => c.usagePageOpen = true),
        _Row('composerFocus', true, (c) => c.composerFocus = true),
        _Row('composerDraft', true, (c) => c.composerDraft = true),
        _Row('turnRunning', true, (c) => c.turnRunning = true),
        _Row('editableFocus', true, (c) => c.editableFocus = true),
        _Row('isWeb', true, (c) => c.isWeb = true),
        _Row('isDesktop', false, (c) => c.isWeb = true),
        _Row('isDesktop', true, (c) => c.isWeb = false),
        _Row('composerFocus && turnRunning', true,
            (c) => c
              ..composerFocus = true
              ..turnRunning = true),
        _Row('composerFocus || turnRunning', true,
            (c) => c.composerFocus = true),
        _Row('!terminalFocus && composerFocus', true,
            (c) => c.composerFocus = true),
        _Row('(composerFocus || paletteOpen) && turnRunning', true,
            (c) => c
              ..paletteOpen = true
              ..turnRunning = true),
        _Row('noSuchContext', false),
      ];
      expect(rows, hasLength(20));

      for (final row in rows) {
        final context = WhenContext(isWeb: false);
        row.setup?.call(context);
        expect(context.evaluate(row.expression), row.expected,
            reason: '"${row.expression}" must evaluate to ${row.expected}');
      }
    });

    test('every context name is settable and negatable', () {
      for (final name in WhenContext.contextNames) {
        final context = WhenContext(isWeb: false);
        final before = context.value(name);
        context.set(name, !before);
        expect(context.value(name), !before, reason: '$name toggles');
        expect(context.evaluate(name), !before, reason: '$name evaluates');
        expect(context.evaluate('!$name'), before, reason: '!$name evaluates');
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

    test('true and false literals evaluate to their boolean value', () {
      final context = WhenContext();

      expect(context.evaluate('true'), isTrue);
      expect(context.evaluate('false'), isFalse);
      expect(context.evaluate('!false'), isTrue);
      expect(context.evaluate('true && false'), isFalse);
      expect(context.evaluate('false || true'), isTrue);
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

    test('platform facts: isDesktop is the complement of isWeb', () {
      final web = WhenContext(isWeb: true);
      expect(web.isWeb, isTrue);
      expect(web.isDesktop, isFalse);

      final desktop = WhenContext(isWeb: false);
      expect(desktop.isWeb, isFalse);
      expect(desktop.isDesktop, isTrue);

      // Writing one updates the other.
      desktop.isWeb = true;
      expect(desktop.isDesktop, isFalse);
      desktop.isDesktop = true;
      expect(desktop.isWeb, isFalse);

      // The isDesktop constructor argument is the complement of isWeb.
      final fromDesktop = WhenContext(isDesktop: true);
      expect(fromDesktop.isWeb, isFalse);
      expect(fromDesktop.isDesktop, isTrue);
    });
  });

  group('WhenContext evidence', () {
    test('truth table (evidence when.txt)', () {
      final context = WhenContext(isWeb: false);
      final buffer = StringBuffer()
        ..writeln('T116 when-context truth table (evaluate over WhenContext)')
        ..writeln('context | evaluate(name) after set true | '
            'evaluate(!name) after set true | evaluate(name) after set false');
      for (final name in WhenContext.contextNames) {
        context.set(name, true);
        final after = context.evaluate(name);
        final notAfter = context.evaluate('!$name');
        context.set(name, false);
        final reset = context.evaluate(name);
        buffer.writeln('$name | $after | $notAfter | $reset');
        expect(after, isTrue, reason: '$name set true');
        expect(notAfter, isFalse, reason: '!$name set true');
        expect(reset, isFalse, reason: '$name reset false');
      }
      buffer
        ..writeln('unknown name: evaluate(nope) = '
            '${context.evaluate('nope')}')
        ..writeln('unknown negated: evaluate(!nope) = '
            '${context.evaluate('!nope')}')
        ..writeln('null expression: evaluate(null) = '
            '${context.evaluate(null)}')
        ..writeln('literal true: evaluate(true) = ${context.evaluate('true')}')
        ..writeln('literal false: evaluate(false) = '
            '${context.evaluate('false')}');
      // ignore: avoid_print — the T116 QA script tees this matrix.
      print(buffer);
    });
  });
}
