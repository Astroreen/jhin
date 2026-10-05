import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/sdui/ui_registry.dart';

/// T94: the Dart-side primitive-catalog conformance — the client registry
/// and the contract document agree on the level-3 surface (docs/sdui.md
/// §2.5, contract level 3).
///
/// Three assertions:
/// 1. the §2.5 catalog parsed out of `docs/sdui.md` has exactly 68 names —
///    the 64 builder types (58 of level 2 plus the six level-3 primitives)
///    plus the four level-3 universal prop names (`glass`, `demo`,
///    `statusPulse`, `safeArea`), which are props of the universal surface,
///    not node types;
/// 2. the registry registers exactly the 64 type names — every catalog type
///    has a builder and the registry has no builder the doc lacks;
/// 3. every level-3 entry declares its degradation (docs/sdui.md §6
///    level-3 → level-2 downgrade table): each of the six primitives maps to
///    its documented level-2 target (a registered type, or the `trigger`
///    replacement for `hover_card`) and each universal prop is marked
///    stripped or kept exactly as the table says. `glassTint` is documented
///    in §2.1/§6 (the `glass` companion), not as a §2.5 catalog name, and
///    degrades stripped like `glass`.
void main() {
  /// The primitive names of the docs/sdui.md §2.5 catalog: every backtick
  /// span of the bullet list (including its wrapped continuation lines)
  /// between the section headings — the same extraction the JVM
  /// `PrimitiveCatalogTest` and the QA `catalog_primitives()` run.
  Set<String> documentedCatalog() {
    final File doc = File.fromUri(
        Directory.current.uri.resolve('../docs/sdui.md').normalizePath());
    expect(doc.existsSync(), isTrue,
        reason: 'docs/sdui.md exists relative to frontend/');
    final Set<String> names = {};
    bool inSection = false;
    for (final String line in doc.readAsLinesSync()) {
      if (line.startsWith('### 2.5 ')) {
        inSection = true;
        continue;
      }
      if (inSection && line.startsWith('### ')) {
        break;
      }
      if (!inSection) {
        continue;
      }
      final String stripped = line.trim();
      final bool bullet = stripped.startsWith('- ');
      final bool continuation = line.startsWith('  ') && stripped.isNotEmpty;
      if (!bullet && !continuation) {
        continue;
      }
      final RegExp span = RegExp(r'`([^`]+)`');
      for (final RegExpMatch match in span.allMatches(line)) {
        names.add(match.group(1)!);
      }
    }
    return names;
  }

  /// The level-3 → level-2 degradation table (docs/sdui.md §6): the six
  /// level-3 primitives and the five universal level-3 names, each with its
  /// documented degradation. `trigger` is the hover_card special shape (the
  /// node is replaced by its trigger, not renamed); `stripped`/`kept` are
  /// the universal-prop fates.
  const Map<String, String> level3Degradations = {
    'split': 'column',
    'hover_card': 'trigger',
    'toast_stack': 'column',
    'kbd': 'text',
    'scroll_fade': 'scroll',
    'diff_view': 'code_block',
    'glass': 'stripped',
    'glassTint': 'stripped',
    'statusPulse': 'stripped',
    'demo': 'kept',
    'safeArea': 'kept',
  };

  /// The four universal prop names of §2.5 — props of the universal surface
  /// (§2.1), not node types, so no builder carries them.
  const Set<String> universalProps = {
    'glass',
    'demo',
    'statusPulse',
    'safeArea',
  };

  /// The ten level-3 names the §2.5 catalog carries (the six primitives plus
  /// the four universal props); `glassTint` completes the degradation table
  /// from §2.1/§6.
  const Set<String> level3CatalogNames = {
    'split',
    'hover_card',
    'toast_stack',
    'kbd',
    'scroll_fade',
    'diff_view',
    'glass',
    'demo',
    'statusPulse',
    'safeArea',
  };

  test('the docs/sdui.md §2.5 catalog has exactly 68 names', () {
    final Set<String> catalog = documentedCatalog();
    expect(catalog, hasLength(68));
    expect(catalog, containsAll(universalProps));
    expect(catalog, containsAll(level3CatalogNames));
  });

  test('the registry registers exactly the 64 catalog types', () {
    final Set<String> catalog = documentedCatalog();
    final Set<String> catalogTypes = {...catalog}..removeAll(universalProps);
    final Set<String> registered = UiRegistry.standard().registeredTypes;

    expect(registered, hasLength(64));
    expect(registered, equals(catalogTypes),
        reason: 'the registry and the §2.5 catalog agree on the type set');
  });

  test('every level-3 entry declares its documented degradation', () {
    final Set<String> catalog = documentedCatalog();
    final Set<String> registered = UiRegistry.standard().registeredTypes;

    // The degradation table covers exactly the level-3 names of the catalog
    // plus the §2.1/§6 `glassTint` companion.
    expect(level3Degradations.keys.toSet(),
        equals({...level3CatalogNames, 'glassTint'}));
    expect(
      catalog.where(level3Degradations.containsKey).toSet(),
      equals(level3CatalogNames),
      reason: 'the table names exactly the level-3 entries of the catalog',
    );

    for (final MapEntry<String, String> entry in level3Degradations.entries) {
      final String target = entry.value;
      if (target == 'stripped' || target == 'kept' || target == 'trigger') {
        continue;
      }
      expect(registered, contains(target),
          reason: '${entry.key} degrades to $target, a registered type');
    }
  });
}