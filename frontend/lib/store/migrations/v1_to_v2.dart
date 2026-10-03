import '../versioned_store.dart';
import 'store_migration.dart';

/// Schema step 1 → 2 (docs/updates.md §5): wrap legacy blobs into the
/// envelope and split `sessionState` per profile.
///
/// The wrapping itself is the runner's enveloped commit (§3 rule 2: "on
/// success write the enveloped value") — the legacy payload shapes are
/// already the schema-2 payload shapes, so [upgrade] is intentionally a
/// no-op. The split is a key-space operation and lives in [sideKeys].
final class V1ToV2 extends StoreMigration {
  @override
  int get from => 1;

  @override
  int get to => 2;

  @override
  void upgrade(Map<String, dynamic> data) {
    // The 1→2 change is the envelope itself, applied by the runner's
    // commit; the payload passes through unchanged.
  }

  @override
  Map<String, Object?> sideKeys(String key, Object? data, StoreLookup lookup) {
    if (key != StoreKeys.legacySessionState || data is! Map<String, dynamic>) {
      return const {};
    }
    // Split the single-profile-era session state per profile: the target is
    // the profile the state names, else the active profile, else the first
    // stored profile. The legacy key itself is never destroyed — it stays
    // enveloped at the current schema.
    final explicit = data['profileId'];
    final profileId =
        explicit is String && explicit.isNotEmpty ? explicit : _impliedProfileId(lookup);
    if (profileId == null) return const {};
    final target = StoreKeys.sessionState(profileId);
    if (lookup.exists(target)) return const {}; // never clobber
    return {target: data};
  }

  /// The profile the legacy state belongs to when the blob does not say.
  String? _impliedProfileId(StoreLookup lookup) {
    final active = lookup.data(StoreKeys.activeProfileId);
    if (active is String && active.isNotEmpty) return active;
    final profiles = lookup.data(StoreKeys.profiles);
    if (profiles is List && profiles.isNotEmpty && profiles.first is Map) {
      final id = (profiles.first as Map)['id'];
      if (id is String && id.isNotEmpty) return id;
    }
    return null;
  }
}
