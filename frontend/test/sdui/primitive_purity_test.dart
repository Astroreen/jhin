import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// T86: the primitive purity gate — no literal colour (`Color(0x`) and no
/// literal all-sides inset (`EdgeInsets.all(`) anywhere in the primitive
/// sources. Every colour and spacing constant must come from the token
/// layer (`design/tokens.dart`, the resolved theme or the shared helpers).
///
/// The QA harness (`scripts/qa/t86.sh --fail`) drops a fixture primitive
/// with a reintroduced `Color(0xFF000000)` into `lib/sdui/primitives/` and
/// expects this test to fail.
void main() {
  test('no literal colour or EdgeInsets.all in the primitive sources', () {
    final dir = Directory('lib/sdui/primitives');
    expect(dir.existsSync(), isTrue,
        reason: 'lib/sdui/primitives must exist (run from frontend/)');
    final offenders = <String>[];
    for (final file in dir
        .listSync()
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))) {
      final lines = file.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].contains('Color(0x')) {
          offenders.add('${file.path}:${i + 1}: Color(0x…');
        }
        if (lines[i].contains('EdgeInsets.all(')) {
          offenders.add('${file.path}:${i + 1}: EdgeInsets.all(…');
        }
      }
    }
    expect(offenders, isEmpty,
        reason: 'literal colours/insets leaked into the primitives:\n'
            '${offenders.join('\n')}');
  });
}
