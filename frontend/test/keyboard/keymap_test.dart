import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/keyboard/command_registry.dart';
import 'package:jhin/sdui/keyboard/keymap.dart';
import 'package:jhin/sdui/keyboard/when_context.dart';

void main() {
  group('KeyChord.parse', () {
    test('mod maps to ctrl on Linux and Windows and meta on macOS', () {
      final linux = KeyChord.parse('mod+enter', platform: KeyPlatform.linux)!;
      final windows =
          KeyChord.parse('mod+enter', platform: KeyPlatform.windows)!;
      final mac = KeyChord.parse('mod+enter', platform: KeyPlatform.macOS)!;
      final other = KeyChord.parse('mod+enter', platform: KeyPlatform.other)!;

      expect(linux.modifiers, {KeyModifier.ctrl});
      expect(windows.modifiers, {KeyModifier.ctrl});
      expect(other.modifiers, {KeyModifier.ctrl});
      expect(mac.modifiers, {KeyModifier.meta});
      expect(linux.key, 'enter');
      expect(mac.key, 'enter');
    });

    test('parses the modifier and key vocabulary', () {
      KeyChord chord(String spec) =>
          KeyChord.parse(spec, platform: KeyPlatform.linux)!;

      expect(chord('ctrl+alt+enter').modifiers,
          {KeyModifier.ctrl, KeyModifier.alt});
      expect(chord('shift+enter').modifiers, {KeyModifier.shift});
      expect(chord('ctrl+k'), KeyChord({KeyModifier.ctrl}, 'k'));
      expect(chord('ctrl+z'), KeyChord({KeyModifier.ctrl}, 'z'));
      expect(chord('mod+n'), KeyChord({KeyModifier.ctrl}, 'n'));
      for (var i = 1; i <= 9; i++) {
        expect(chord('ctrl+$i'), KeyChord({KeyModifier.ctrl}, '$i'));
      }
      expect(chord('enter').key, 'enter');
      expect(chord('escape').key, 'escape');
      expect(chord('tab').key, 'tab');
      expect(chord('space').key, 'space');
      expect(chord('backspace').key, 'backspace');
      expect(chord('delete').key, 'delete');
      expect(chord('up').key, 'up');
      expect(chord('down').key, 'down');
      expect(chord('left').key, 'left');
      expect(chord('right').key, 'right');
      expect(chord('home').key, 'home');
      expect(chord('end').key, 'end');
      expect(chord('pageup').key, 'pageup');
      expect(chord('pagedown').key, 'pagedown');
      expect(chord('a').key, 'a');
      expect(chord('9').key, '9');
    });

    test('malformed specs parse to null and never throw', () {
      for (final spec in <String>[
        '',
        'mod+',
        'ctrl+',
        '+enter',
        'ctrl++enter',
        'frob+enter',
        'ctrl+frob',
        'ctrl+enterr',
        'esc',
      ]) {
        expect(KeyChord.parse(spec, platform: KeyPlatform.linux), isNull,
            reason: '"$spec" must parse to null');
      }
    });
  });

  group('Keymap.commandFor', () {
    final platform = KeyPlatform.linux;

    Keymap parseOne(List<Object?> entries) => Keymap.parse(entries,
        platform: platform);

    test('mod+enter resolves composer.send when composerFocus is on', () {
      final keymap = parseOne([
        {'key': 'mod+enter', 'command': 'composer.send', 'when': 'composerFocus'},
      ]);
      final chord = KeyChord.parse('mod+enter', platform: platform)!;

      final focused = WhenContext()..composerFocus = true;
      expect(keymap.commandFor(chord, focused), 'composer.send');

      final unfocused = WhenContext();
      expect(keymap.commandFor(chord, unfocused), isNull);
    });

    test("when:'!composerFocus' excludes the rule while composerFocus is on",
        () {
      final keymap = parseOne([
        {
          'key': 'ctrl+k',
          'command': 'palette.open',
          'when': '!composerFocus',
        },
      ]);
      final chord = KeyChord.parse('ctrl+k', platform: platform)!;

      expect(keymap.commandFor(chord, WhenContext()), 'palette.open');
      expect(
        keymap.commandFor(chord, WhenContext()..composerFocus = true),
        isNull,
      );
    });

    test('last matching rule wins', () {
      final keymap = parseOne([
        {'key': 'ctrl+k', 'command': 'palette.open'},
        {'key': 'ctrl+k', 'command': 'theme.pick'},
      ]);
      final chord = KeyChord.parse('ctrl+k', platform: platform)!;

      expect(keymap.commandFor(chord, WhenContext()), 'theme.pick');
    });

    test('T116 last-match-wins: the resolution walks the rules from the end',
        () {
      // Three rules on the same chord; the last active one wins regardless
      // of how many earlier rules also match.
      final keymap = parseOne([
        {'key': 'ctrl+k', 'command': 'first'},
        {'key': 'ctrl+k', 'command': 'second'},
        {'key': 'ctrl+k', 'command': 'third'},
      ]);
      final chord = KeyChord.parse('ctrl+k', platform: platform)!;

      expect(keymap.commandFor(chord, WhenContext()), 'third');

      // A later rule whose `when` is inactive is skipped; the previous
      // active rule wins.
      final gated = parseOne([
        {'key': 'ctrl+k', 'command': 'first'},
        {'key': 'ctrl+k', 'command': 'second'},
        {'key': 'ctrl+k', 'command': 'third', 'when': 'paletteOpen'},
      ]);
      expect(gated.commandFor(chord, WhenContext()), 'second');
      expect(gated.commandFor(chord, WhenContext()..paletteOpen = true),
          'third');
    });

    test('later rules win only when their when is active', () {
      final keymap = parseOne([
        {'key': 'ctrl+k', 'command': 'palette.open'},
        {'key': 'ctrl+k', 'command': 'theme.pick', 'when': 'paletteOpen'},
      ]);
      final chord = KeyChord.parse('ctrl+k', platform: platform)!;

      expect(keymap.commandFor(chord, WhenContext()), 'palette.open');
      expect(
        keymap.commandFor(chord, WhenContext()..paletteOpen = true),
        'theme.pick',
      );
    });

    test('typing policy: context-free rules suspend while text entry is '
        'active; when-qualified rules follow their expression', () {
      final keymap = parseOne([
        {'key': 'ctrl+k', 'command': 'palette.open'},
        {'key': 'shift+enter', 'command': 'composer.newline', 'when': 'composerFocus'},
      ]);
      final plain = KeyChord.parse('ctrl+k', platform: platform)!;
      final composer = KeyChord.parse('shift+enter', platform: platform)!;

      final typing = WhenContext()..editableFocus = true;
      expect(keymap.commandFor(plain, typing), isNull);
      expect(keymap.commandFor(plain, typing, textEntryActive: false),
          'palette.open');

      final composing = WhenContext()..composerFocus = true;
      expect(keymap.commandFor(composer, composing), 'composer.newline');
    });

    test('malformed entries are ignored and never throw', () {
      final keymap = parseOne([
        'not-a-map',
        {'key': 'mod+', 'command': 'composer.send'},
        {'key': '', 'command': 'composer.send'},
        {'key': 'ctrl+frob', 'command': 'composer.send'},
        {'key': 'mod+enter'},
        {'key': 'mod+enter', 'command': ''},
        {'key': 'mod+enter', 'command': 'composer.send'},
      ]);

      expect(keymap.rules, hasLength(1));
      expect(keymap.rules.single.command, 'composer.send');
    });

    test('unknown commands resolve and dispatch as no-ops', () {
      final registry = CommandRegistry();
      final keymap = parseOne([
        {'key': 'ctrl+9', 'command': 'not.a.command'},
      ]);
      final chord = KeyChord.parse('ctrl+9', platform: platform)!;

      expect(keymap.commandFor(chord, WhenContext()), 'not.a.command');
      expect(() => registry.dispatch('not.a.command'), returnsNormally);
    });
  });

  group('Keymap.resolve', () {
    final platform = KeyPlatform.linux;

    test('user overrides win per command and un-overridden defaults survive',
        () {
      final defaults = [
        {'key': 'mod+enter', 'command': 'composer.send', 'when': 'composerFocus'},
        {'key': 'shift+enter', 'command': 'composer.newline', 'when': 'composerFocus'},
        {'key': 'ctrl+k', 'command': 'palette.open'},
      ];
      final rebinds = [
        {'command': 'composer.send', 'keys': 'mod+shift+enter'},
      ];

      final effective = Keymap.resolve(defaults, rebinds, platform: platform);

      expect(effective.rules, hasLength(3));
      final byCommand = {
        for (final rule in effective.rules) rule.command: rule,
      };
      expect(byCommand['composer.send']!.chord,
          KeyChord({KeyModifier.ctrl, KeyModifier.shift}, 'enter'));
      expect(byCommand['composer.send']!.when, 'composerFocus');
      expect(byCommand['composer.newline']!.chord,
          KeyChord({KeyModifier.shift}, 'enter'));
      expect(byCommand['palette.open']!.chord,
          KeyChord({KeyModifier.ctrl}, 'k'));
    });

    test('a user rebinding replaces every default rule of that command and '
        'newly added server defaults are never dropped', () {
      final defaults = [
        {'key': 'ctrl+z', 'command': 'thread.undo'},
        {'key': 'ctrl+alt+z', 'command': 'thread.undo'},
        {'key': 'mod+n', 'command': 'thread.new'},
      ];
      final rebinds = [
        {'command': 'thread.undo', 'keys': 'ctrl+u'},
      ];

      final effective = Keymap.resolve(defaults, rebinds, platform: platform);

      final undoRules =
          effective.rules.where((rule) => rule.command == 'thread.undo');
      expect(undoRules, hasLength(1));
      expect(undoRules.single.chord, KeyChord({KeyModifier.ctrl}, 'u'));
      expect(
        effective.rules.any((rule) => rule.command == 'thread.new'),
        isTrue,
        reason: 'an un-overridden server default must survive the merge',
      );
    });

    test('user-added commands are kept and sit last for the last-match '
        'tie-break', () {
      final defaults = [
        {'key': 'ctrl+k', 'command': 'palette.open'},
      ];
      final rebinds = [
        {'command': 'theme.pick', 'keys': 'ctrl+k'},
      ];

      final effective = Keymap.resolve(defaults, rebinds, platform: platform);

      expect(effective.rules, hasLength(2));
      expect(effective.rules.last.command, 'theme.pick');
      expect(
        effective.commandFor(
          KeyChord.parse('ctrl+k', platform: platform)!,
          WhenContext(),
        ),
        'theme.pick',
      );
    });
  });

  group('keymap evidence', () {
    test('key parse matrix (evidence parse.txt)', () {
      const specs = <String>[
        'mod+enter',
        'ctrl+alt+enter',
        'shift+enter',
        'mod+up',
        'mod+down',
        'ctrl+k',
        'ctrl+z',
        'alt+left',
        'alt+right',
        'mod+n',
        'ctrl+1',
        'ctrl+9',
        'escape',
        'pagedown',
      ];
      final buffer = StringBuffer()
        ..writeln('T67 key parse matrix (KeyChord.parse)');
      for (final platform in KeyPlatform.values) {
        for (final spec in specs) {
          final chord = KeyChord.parse(spec, platform: platform);
          buffer.writeln('$spec platform=${platform.name} -> $chord');
        }
      }
      buffer.writeln('mod+enter platform=linux -> '
          '${KeyChord.parse('mod+enter', platform: KeyPlatform.linux)}');
      buffer.writeln('mod+enter platform=windows -> '
          '${KeyChord.parse('mod+enter', platform: KeyPlatform.windows)}');
      buffer.writeln('mod+enter platform=macOS -> '
          '${KeyChord.parse('mod+enter', platform: KeyPlatform.macOS)}');
      buffer.writeln('mod+enter platform=other -> '
          '${KeyChord.parse('mod+enter', platform: KeyPlatform.other)}');
      // ignore: avoid_print — the T67 QA script tees this matrix.
      print(buffer);

      expect(KeyChord.parse('mod+enter', platform: KeyPlatform.linux)!.modifiers,
          {KeyModifier.ctrl});
      expect(KeyChord.parse('mod+enter', platform: KeyPlatform.macOS)!.modifiers,
          {KeyModifier.meta});
    });

    test('negative cases (evidence negative.txt)', () {
      final buffer = StringBuffer()
        ..writeln('T67 negative cases');
      for (final spec in <String>['mod+', '', 'ctrl+frob', 'frob+enter']) {
        final chord = KeyChord.parse(spec, platform: KeyPlatform.linux);
        buffer.writeln("parse('$spec') -> $chord (ignored)");
        expect(chord, isNull);
      }
      final context = WhenContext();
      buffer.writeln("evaluate('nope') -> ${context.evaluate('nope')}");
      expect(context.evaluate('nope'), isFalse);
      buffer.writeln("evaluate('!nope') -> ${context.evaluate('!nope')} "
          '(negation of false)');
      buffer.writeln("evaluate('a &&') -> ${context.evaluate('a &&')} "
          '(malformed degrades to false)');
      expect(context.evaluate('a &&'), isFalse);

      final registry = CommandRegistry();
      buffer.writeln("dispatch('no.such.command') -> no-op, no throw");
      expect(() => registry.dispatch('no.such.command'), returnsNormally);

      final keymap = Keymap.parse([
        {'key': 'ctrl+frob', 'command': 'composer.send'},
        {'key': 'mod+', 'command': 'composer.send'},
      ], platform: KeyPlatform.linux);
      buffer.writeln(
          'malformed keymap entries dropped -> ${keymap.rules.length} rules');
      expect(keymap.rules, isEmpty);
      // ignore: avoid_print — the T67 QA script tees this transcript.
      print(buffer);
    });
  });
}
