import '../versioned_store.dart';
import 'store_migration.dart';

/// Schema step 2 → 3 (docs/updates.md §5): introduce `appearance` +
/// `keybindings` + `tokensEtag` and migrate the old `theme` key into
/// `appearance`.
///
/// The introductions are key-space operations ([introduced]; the runner
/// seeds them only when absent, so an existing `keybindings` file is never
/// clobbered). The `theme` → `appearance` move is [sideKeys]; the legacy
/// `theme` key itself is never destroyed — it stays enveloped at the
/// current schema. [upgrade] stays the per-blob extension point for future
/// steps.
final class V2ToV3 extends StoreMigration {
  @override
  int get from => 2;

  @override
  int get to => 3;

  @override
  void upgrade(Map<String, dynamic> data) {
    // No payload-level transform in this step: its changes are key-space
    // operations (below). The hook remains the per-blob transform point for
    // future steps (docs/updates.md §6).
  }

  @override
  Map<String, Object?> sideKeys(String key, Object? data, StoreLookup lookup) {
    if (key != StoreKeys.legacyTheme) return const {};
    if (lookup.exists(StoreKeys.appearance)) return const {}; // never clobber
    // Migrate the old theme key into appearance: the theme mode becomes
    // `themeMode`, the remaining appearance fields take their defaults.
    final appearance = <String, dynamic>{
      'themeMode': 'system',
      'textSize': 14,
      'density': 'comfortable',
      'panelMotionMs': 0,
    };
    if (data is Map<String, dynamic>) {
      final mode = data['mode'] ?? data['appearance'];
      if (mode is String && mode.isNotEmpty) appearance['themeMode'] = mode;
    }
    return {StoreKeys.appearance: appearance};
  }

  @override
  Map<String, Object?> introduced() => const {
        StoreKeys.appearance: {
          'themeMode': 'system',
          'textSize': 14,
          'density': 'comfortable',
          'panelMotionMs': 0,
        },
        StoreKeys.keybindings: {'rules': []},
        StoreKeys.tokensEtag: {'etag': ''},
      };
}
