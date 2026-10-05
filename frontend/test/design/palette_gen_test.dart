// PaletteGen: the Dart port of the two-seed OKLCH generator against the
// shared vector set — the five built-in seed pairs of
// packages/shared/src/themePalettes.ts plus four adversarial pairs.
//
// The byte-parity claim of the plan (§15.2) is asserted here against the
// Java-produced goldens (t84_golden_data.dart): every hex string of every
// generated map must match the Java output exactly after 8-bit
// quantization. The suite also writes its own dump when T84_DUMP is set so
// scripts/qa/t84.sh can diff the two sides byte for byte.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';

import 't84_golden_data.dart';

class _Vector {
  const _Vector(this.name, this.appearance, this.canvas, this.accent);

  final String name;
  final String appearance;
  final String canvas;
  final String accent;
}

const List<_Vector> _vectors = [
  _Vector('t3-chat', 'light', '#fdf7fd', '#db2777'),
  _Vector('grove', 'light', '#f3f7f4', '#1b7d50'),
  _Vector('ocean', 'light', '#f5f7f8', '#2672af'),
  _Vector('ember', 'light', '#f9f7f5', '#ae552a'),
  _Vector('iris', 'light', '#f8f7f9', '#7253b9'),
  _Vector('near-black-grey', 'dark', '#050505', '#808080'),
  _Vector('white-white', 'light', '#ffffff', '#ffffff'),
  _Vector('max-chroma-magenta', 'light', '#ff00ff', '#ff00ff'),
  _Vector('mid-grey', 'light', '#808080', '#808080'),
];

void main() {
  final Map<String, dynamic> golden =
      json.decode(t84GoldenJson) as Map<String, dynamic>;
  final List<dynamic> goldenVectors = golden['vectors'] as List<dynamic>;

  Map<String, String> goldenColors(String name) {
    for (final dynamic entry in goldenVectors) {
      final Map<String, dynamic> vector = entry as Map<String, dynamic>;
      if (vector['name'] == name) {
        return (vector['colors'] as Map<String, dynamic>)
            .map((key, value) => MapEntry(key, value as String));
      }
    }
    fail('no golden for vector $name');
  }

  group('PaletteGen — byte parity with the Java port', () {
    test('the golden covers the shared vector set', () {
      expect(goldenVectors.length, _vectors.length);
      expect(
        goldenVectors
            .map((dynamic e) => (e as Map<String, dynamic>)['name'])
            .toList(),
        _vectors.map((v) => v.name).toList(),
      );
    });

    for (final _Vector vector in _vectors) {
      test('${vector.name}: every hex string matches the Java output', () {
        final Map<String, String> generated = generate(
          vector.appearance,
          vector.canvas,
          vector.accent,
        );
        final Map<String, String> expected = goldenColors(vector.name);
        expect(generated.keys.toSet(), expected.keys.toSet(),
            reason: 'key set of ${vector.name}');
        for (final String key in expected.keys) {
          expect(generated[key], expected[key],
              reason: '${vector.name}.$key must be byte-identical to Java');
        }
      });
    }
  });

  group('PaletteGen — shared vector structure', () {
    test('seeds are honored exactly', () {
      for (final _Vector vector in _vectors) {
        final Map<String, String> colors =
            generate(vector.appearance, vector.canvas, vector.accent);
        expect(colors['background'], vector.canvas,
            reason: 'canvas of ${vector.name}');
        expect(colors['ring'], vector.accent, reason: 'accent of ${vector.name}');
        expect(colors['update'], vector.accent,
            reason: 'update of ${vector.name}');
      }
    });

    test('every map carries the 56 semantic color names', () {
      final List<String> expected = (goldenColors('t3-chat').keys.toList()
        ..sort());
      expect(expected.length, 56);
      for (final _Vector vector in _vectors) {
        final Map<String, String> colors =
            generate(vector.appearance, vector.canvas, vector.accent);
        expect((colors.keys.toList()..sort()), expected,
            reason: 'key set of ${vector.name}');
      }
    });

    test('the companion action is a distinct voice, not the accent', () {
      for (final _Vector vector in _vectors) {
        final Map<String, String> colors =
            generate(vector.appearance, vector.canvas, vector.accent);
        expect(colors['message-action'], isNot(colors['ring']),
            reason: 'companion of ${vector.name}');
      }
    });

    test('system resolves off the canvas', () {
      expect(
        generate('system', '#fdf7fd', '#db2777'),
        generate('light', '#fdf7fd', '#db2777'),
      );
      expect(
        generate('system', '#111827', '#8ab4f8'),
        generate('dark', '#111827', '#8ab4f8'),
      );
    });
  });

  group('PaletteGen — typed failures', () {
    test('unparsable seeds raise PaletteError', () {
      expect(() => generate('light', 'not-a-colour', '#db2777'),
          throwsA(isA<PaletteError>()));
      expect(() => generate('light', '#fdf7fd', 'not-a-colour'),
          throwsA(isA<PaletteError>()));
      expect(() => generate('light', '#12345', '#db2777'),
          throwsA(isA<PaletteError>()));
    });

    test('unknown appearance raises PaletteError', () {
      expect(() => generate('sepia', '#fdf7fd', '#db2777'),
          throwsA(isA<PaletteError>()));
    });
  });

  group('PaletteGen — QA dump', () {
    test('writes the vector dump for the parity diff when asked', () {
      final String? target = Platform.environment['T84_DUMP'];
      if (target == null || target.isEmpty) {
        return;
      }
      final StringBuffer json = StringBuffer('{\n  "vectors": [\n');
      for (int i = 0; i < _vectors.length; i++) {
        final _Vector vector = _vectors[i];
        final Map<String, String> colors =
            Map<String, String>.from(generate(
          vector.appearance,
          vector.canvas,
          vector.accent,
        ));
        final List<String> keys = colors.keys.toList()..sort();
        json.write('    {"name": "${vector.name}", '
            '"appearance": "${vector.appearance}", '
            '"canvas": "${vector.canvas}", '
            '"accent": "${vector.accent}", "colors": {');
        for (int k = 0; k < keys.length; k++) {
          if (k > 0) {
            json.write(', ');
          }
          json.write('"${keys[k]}": "${colors[keys[k]]}"');
        }
        json.write('}}');
        if (i + 1 < _vectors.length) {
          json.write(',');
        }
        json.write('\n');
      }
      json.write('  ]\n}\n');
      File(target).writeAsStringSync(json.toString());
      expect(File(target).existsSync(), isTrue);
    });
  });
}
