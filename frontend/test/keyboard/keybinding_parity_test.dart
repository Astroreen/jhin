// ignore_for_file: avoid_print — the T116 QA script tees this transcript.
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/keyboard/keymap.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';

/// T116 keybinding parity: the upstream t3code default chords
/// (`packages/shared/src/keybindings.ts:21-104`, commit 37de6cb) resolve to
/// their command ids through the client keymap, the `mod+w` precedence holds
/// (terminal first, right panel otherwise) and the `mod+1..9` jumps are
/// gated on `isDesktop`.
///
/// The list mirrors the server `DefaultKeymap` additions
/// (`plugins/ui-default/.../DefaultKeymap.java`); the QA script additionally
/// fetches the live bootstrap `keymap` and asserts the same chords are
/// present server-side.
const List<Map<String, Object?>> _upstreamAdditions = <Map<String, Object?>>[
  {'key': 'mod+[', 'command': 'navigation.back', 'when': '!terminalFocus'},
  {'key': 'mod+]', 'command': 'navigation.forward', 'when': '!terminalFocus'},
  {'key': 'mod+j', 'command': 'terminal.toggle'},
  {'key': 'mod+w', 'command': 'terminal.close', 'when': 'terminalFocus'},
  {'key': 'mod+w', 'command': 'rightPanel.close', 'when': '!terminalFocus'},
  {'key': 'mod+alt+n', 'command': 'chat.newWithoutProject', 'when': '!terminalFocus'},
  {
    'key': 'mod+shift+enter',
    'command': 'thread.steerQueuedMessage',
    'when': '!terminalFocus',
  },
  {'key': 'mod+1', 'command': 'thread.jump1', 'when': 'isDesktop'},
  {'key': 'mod+9', 'command': 'thread.jump9', 'when': 'isDesktop'},
];

/// The deliberately wrong expectation of the `--fail` run: an unknown `when`
/// key is expected to evaluate `true` (it evaluates `false` and never throws).
const bool _failMode = bool.fromEnvironment('T116_FAIL_MODE');

void main() {
  final platform = KeyPlatform.linux;

  Keymap keymap() => Keymap.parse(_upstreamAdditions, platform: platform);

  KeyChord chord(String spec) => KeyChord.parse(spec, platform: platform)!;

  group('T116 upstream default chords', () {
    test('each upstream default chord resolves to its command id', () {
      final map = keymap();
      final context = WhenContext(isWeb: false);

      expect(map.commandFor(chord('mod+['), context), 'navigation.back');
      expect(map.commandFor(chord('mod+]'), context), 'navigation.forward');
      expect(map.commandFor(chord('mod+j'), context), 'terminal.toggle');
      expect(map.commandFor(chord('mod+alt+n'), context),
          'chat.newWithoutProject');
      expect(map.commandFor(chord('mod+shift+enter'), context),
          'thread.steerQueuedMessage');
      expect(map.commandFor(chord('mod+1'), context), 'thread.jump1');
      expect(map.commandFor(chord('mod+9'), context), 'thread.jump9');
    });

    test('the !terminalFocus guard suppresses the navigation chords', () {
      final map = keymap();
      final focused = WhenContext(isWeb: false)..terminalFocus = true;

      expect(map.commandFor(chord('mod+['), focused), isNull);
      expect(map.commandFor(chord('mod+]'), focused), isNull);
      expect(map.commandFor(chord('mod+alt+n'), focused), isNull);
      expect(map.commandFor(chord('mod+shift+enter'), focused), isNull);
    });

    test('mod+w precedence: terminal.close while terminalFocus, '
        'rightPanel.close otherwise', () {
      final map = keymap();

      final terminal = WhenContext(isWeb: false)..terminalFocus = true;
      expect(map.commandFor(chord('mod+w'), terminal), 'terminal.close');

      final elsewhere = WhenContext(isWeb: false);
      expect(map.commandFor(chord('mod+w'), elsewhere), 'rightPanel.close');
    });

    test('mod+1..9 jumps are gated on isDesktop', () {
      final map = keymap();

      final desktop = WhenContext(isWeb: false);
      expect(map.commandFor(chord('mod+1'), desktop), 'thread.jump1');

      final web = WhenContext(isWeb: true);
      expect(map.commandFor(chord('mod+1'), web), isNull);
      expect(map.commandFor(chord('mod+9'), web), isNull);
    });

    test('unknown when keys evaluate false and never throw', () {
      final map = Keymap.parse([
        {'key': 'ctrl+k', 'command': 'palette.open', 'when': 'noSuchContext'},
      ], platform: platform);
      final context = WhenContext();

      expect(context.evaluate('noSuchContext'), isFalse);
      expect(map.commandFor(chord('ctrl+k'), context), isNull);
      expect(() => map.commandFor(chord('ctrl+k'), context), returnsNormally);
    });
  });

  group('T116 keymap evidence', () {
    test('resolution matrix (evidence keymap.json)', () {
      final map = keymap();
      final contexts = <String, WhenContext>{
        'idle': WhenContext(isWeb: false),
        'terminalFocus': WhenContext(isWeb: false)..terminalFocus = true,
        'web': WhenContext(isWeb: true),
      };
      final specs = <String>[
        'mod+[',
        'mod+]',
        'mod+j',
        'mod+w',
        'mod+alt+n',
        'mod+shift+enter',
        'mod+1',
        'mod+9',
      ];
      final buffer = StringBuffer()
        ..writeln('T116 keymap resolution matrix (Keymap.commandFor)');
      for (final entry in contexts.entries) {
        for (final spec in specs) {
          final resolved = map.commandFor(chord(spec), entry.value);
          buffer.writeln('$spec context=${entry.key} -> $resolved');
        }
      }
      print(buffer);
      expect(map.commandFor(chord('mod+w'), contexts['idle']!),
          'rightPanel.close');
    });
  });

  if (_failMode) {
    test('FAIL MODE: an unknown when key is expected to evaluate true', () {
      final context = WhenContext();
      // The deliberately wrong expectation: an unknown key evaluates true.
      expect(context.evaluate('noSuchContext'), isTrue);
    });
  }
}
