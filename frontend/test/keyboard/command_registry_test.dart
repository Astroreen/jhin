import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/keyboard/command_registry.dart';

void main() {
  group('CommandRegistry', () {
    test('dispatch calls a registered handler exactly once', () {
      final registry = CommandRegistry();
      var calls = 0;
      registry.register('composer.send', handler: () { calls++; return true; });

      registry.dispatch('composer.send');

      expect(calls, 1);
    });

    test('enabled:false handler is not called', () {
      final registry = CommandRegistry();
      var calls = 0;
      registry.register(
        'composer.send',
        handler: () { calls++; return true; },
        enabled: () => false,
      );

      registry.dispatch('composer.send');

      expect(calls, 0);
    });

    test('when predicate false handler is not called', () {
      final registry = CommandRegistry();
      var calls = 0;
      registry.register(
        'thread.pin',
        handler: () { calls++; return true; },
        when: () => false,
      );

      registry.dispatch('thread.pin');

      expect(calls, 0);
    });

    test('unknown command dispatch is a no-op that never throws', () {
      final registry = CommandRegistry();

      expect(() => registry.dispatch('no.such.command'), returnsNormally);
    });

    test('every vocabulary id is registered', () {
      final registry = CommandRegistry();

      // T103 grew the vocabulary: the 25 T67–T70 ids plus the alternate send
      // and the seven picker commands. T116 added the nine upstream parity
      // ids (navigation back/forward, thread.stop, terminal toggle/close,
      // rightPanel.close, chat.newWithoutProject, thread.steerQueuedMessage,
      // composer.sendBackground).
      expect(CommandRegistry.vocabularyIds, hasLength(42));
      for (final id in CommandRegistry.vocabularyIds) {
        expect(registry.isRegistered(id), isTrue, reason: 'missing $id');
        expect(registry.ids, contains(id));
      }
    });

    test('every vocabulary id dispatches without throwing', () {
      final registry = CommandRegistry();

      for (final id in CommandRegistry.vocabularyIds) {
        expect(() => registry.dispatch(id), returnsNormally);
      }
    });

    test('re-registering replaces the previous handler', () {
      final registry = CommandRegistry();
      var first = 0;
      var second = 0;
      registry.register('theme.pick', handler: () { first++; return true; });
      registry.register('theme.pick', handler: () { second++; return true; });

      registry.dispatch('theme.pick');

      expect(first, 0);
      expect(second, 1);
    });

    test('a throwing handler is absorbed and never propagates', () {
      final registry = CommandRegistry();
      registry.register('appearance.cycle', handler: () => throw StateError('boom'));

      expect(() => registry.dispatch('appearance.cycle'), returnsNormally);
    });
  });
}
