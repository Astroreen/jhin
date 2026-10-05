import '../versioned_store.dart';
import 'store_migration.dart';

/// Schema step 3 → 4 (T85): persist the selected catalogue theme id in the
/// appearance preferences.
///
/// The `appearance` key gains a `themeId` field, seeded with the default
/// theme `t3-chat`. The step never clobbers: an appearance payload that
/// already carries a `themeId` (a newer save restored from a backup) keeps
/// it, and every other field passes through untouched — no data loss. The
/// seeding rides [sideKeys] (the runner commits the merged map enveloped
/// right after the migrated key), because [upgrade] sees only the payload
/// and cannot tell which key it belongs to. A store with no `appearance`
/// key at all is covered by the reader default (`AppearancePrefs`), since
/// the 2→3 step seeds that key at the current schema and this step's
/// [introduced] hook therefore never fires for it.
final class V3ToV4 extends StoreMigration {
  /// The theme id a migrated appearance gains when it carries none.
  static const String defaultThemeId = 't3-chat';

  @override
  int get from => 3;

  @override
  int get to => 4;

  @override
  void upgrade(Map<String, dynamic> data) {
    // No payload-level transform: the theme id is added per key below.
  }

  @override
  Map<String, Object?> sideKeys(String key, Object? data, StoreLookup lookup) {
    if (key != StoreKeys.appearance || data is! Map) return const {};
    if (data['themeId'] != null) return const {}; // never clobber
    final merged = Map<String, dynamic>.from(data);
    merged['themeId'] = defaultThemeId;
    return {StoreKeys.appearance: merged};
  }
}
