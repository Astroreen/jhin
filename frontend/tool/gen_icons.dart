// Generates frontend/lib/design/icon_registry.dart from the Flutter SDK's
// material/icons.dart: every `static const IconData <name> = IconData(...)`
// entry becomes one `kIconRegistry` name (docs/sdui.md §2.6 `icon`/`icon_button`
// resolve icon names through that registry only).
//
// Regenerate (development-time dev tool — the output is committed, the
// product never runs this):
//
//   devenv shell -- dart frontend/tool/gen_icons.dart
//
// The source file is located automatically (argument > FLUTTER_ROOT > the
// Dart VM's SDK > the `flutter` executable on PATH), or passed explicitly:
//
//   dart frontend/tool/gen_icons.dart <path-to-icons.dart-or-sdk-root>
//
// Idempotent: entries are sorted by name and formatted deterministically, so
// a re-run over the same SDK rewrites the file byte-identically.
import 'dart:io';

const String outputRelativePath = 'lib/design/icon_registry.dart';

const String iconsRelativePath =
    'packages/flutter/lib/src/material/icons.dart';

/// One parsed `static const IconData` entry of the SDK's `Icons` class.
class IconEntry {
  const IconEntry(this.name, this.codePoint, this.fontFamily, this.matchTextDirection);

  final String name;
  final int codePoint;
  final String? fontFamily;
  final bool matchTextDirection;
}

void main(List<String> args) {
  final source = _locateIconsFile(args);
  stdout.writeln('gen_icons: reading $source');

  final text = File(source).readAsStringSync();
  final entries = _parseEntries(text);
  if (entries.isEmpty) {
    stderr.writeln('gen_icons: no `static const IconData` entries found in $source');
    exit(1);
  }
  entries.sort((a, b) => a.name.compareTo(b.name));

  final output = _outputFile();
  output.writeAsStringSync(_render(source, entries));
  stdout.writeln('gen_icons: wrote ${output.path} (${entries.length} names)');
}

/// The icons.dart to parse: explicit argument, `FLUTTER_ROOT`, the Dart VM's
/// SDK layout, or the `flutter` executable on PATH (pure Dart — no external
/// binary is executed).
String _locateIconsFile(List<String> args) {
  final candidates = <String?>[
    if (args.isNotEmpty) _iconsUnder(args.first),
    _iconsUnder(Platform.environment['FLUTTER_ROOT']),
    _iconsUnder(_dartSdkRoot()),
    _iconsUnder(_flutterSdkRootFromPath()),
  ];
  for (final candidate in candidates) {
    if (candidate != null && File(candidate).existsSync()) {
      return candidate;
    }
  }
  stderr.writeln('gen_icons: could not locate $iconsRelativePath');
  stderr.writeln('  tried: CLI argument, FLUTTER_ROOT, the Dart SDK next to '
      'Platform.resolvedExecutable and `flutter` on PATH');
  exit(1);
}

String? _iconsUnder(String? root) =>
    root == null || root.isEmpty ? null : '$root/$iconsRelativePath';

/// `<dart>/bin/dart` -> `<dart>`; null when the VM is not laid out that way.
String? _dartSdkRoot() {
  final dart = File(Platform.resolvedExecutable);
  final bin = dart.parent;
  if (bin.path.endsWith('bin')) return bin.parent.path;
  return null;
}

/// The SDK root of the `flutter` executable on PATH: `<sdk>/bin/flutter` ->
/// `<sdk>`. Symlinks are resolved first (NixOS wraps the SDK in a link farm).
String? _flutterSdkRootFromPath() {
  final path = Platform.environment['PATH'];
  if (path == null) return null;
  for (final dir in path.split(':')) {
    if (dir.isEmpty) continue;
    final flutter = File('$dir/flutter');
    if (!flutter.existsSync()) continue;
    String resolved;
    try {
      resolved = flutter.resolveSymbolicLinksSync();
    } on FileSystemException {
      resolved = flutter.absolute.path;
    }
    final bin = File(resolved).parent;
    if (bin.path.endsWith('bin')) return bin.parent.path;
    return bin.path;
  }
  return null;
}

/// Every `static const IconData <name> = IconData(<args>);` entry, in source
/// order. The argument list is parsed for the code point and the named
/// arguments the SDK uses (`fontFamily`, `matchTextDirection`, `fontPackage`).
List<IconEntry> _parseEntries(String text) {
  final entries = <IconEntry>[];
  final declaration = RegExp(
    r'static const IconData (\w+) = IconData\(([^;]+)\);',
    dotAll: true,
  );
  for (final match in declaration.allMatches(text)) {
    final name = match.group(1)!;
    final args = match.group(2)!;
    final codePointMatch = RegExp(r'0x([0-9a-fA-F]+)').firstMatch(args);
    if (codePointMatch == null) continue;
    final codePoint = int.parse(codePointMatch.group(1)!, radix: 16);
    final fontFamily =
        RegExp(r"fontFamily:\s*'([^']*)'").firstMatch(args)?.group(1);
    final matchTextDirection =
        RegExp(r'matchTextDirection:\s*(true|false)').firstMatch(args)?.group(1) ==
            'true';
    entries.add(IconEntry(name, codePoint, fontFamily, matchTextDirection));
  }
  return entries;
}

/// `frontend/lib/design/icon_registry.dart`, next to this script's package.
File _outputFile() {
  final script = Platform.script.toFilePath();
  final toolDir = File(script).parent;
  final packageRoot = toolDir.parent.path;
  return File('$packageRoot/$outputRelativePath');
}

String _render(String source, List<IconEntry> entries) {
  final buffer = StringBuffer();
  buffer.writeln('// GENERATED by frontend/tool/gen_icons.dart — do not edit.');
  buffer.writeln('// Regenerate: devenv shell -- dart frontend/tool/gen_icons.dart');
  buffer.writeln('// Source: $source');
  buffer.writeln('// Names: ${entries.length} (every `static const IconData` of the');
  buffer.writeln("// SDK's Icons class, sorted alphabetically).");
  buffer.writeln('import \'package:flutter/material.dart\';');
  buffer.writeln();
  buffer.writeln('/// Every Material icon name of the Flutter SDK `Icons` class, keyed');
  buffer.writeln('/// by the exact identifier a server sends as an `icon` name.');
  buffer.writeln('///');
  buffer.writeln('/// Lookup is by name only (docs/sdui.md §2.6): an unknown name renders');
  buffer.writeln('/// an empty icon and logs — never a crash (§2.4). Release builds need');
  buffer.writeln('/// `--no-tree-shake-icons` — see README.md — because these entries are');
  buffer.writeln('/// resolved dynamically and would be tree-shaken out of the font.');
  buffer.writeln('const Map<String, IconData> kIconRegistry = {');
  for (final entry in entries) {
    buffer.write("  '${entry.name}': IconData(0x${entry.codePoint.toRadixString(16)}");
    if (entry.fontFamily != null) {
      buffer.write(", fontFamily: '${entry.fontFamily}'");
    }
    if (entry.matchTextDirection) {
      buffer.write(', matchTextDirection: true');
    }
    buffer.writeln('),');
  }
  buffer.writeln('};');
  return buffer.toString();
}