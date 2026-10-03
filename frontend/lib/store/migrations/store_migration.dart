/// The migration step contract (docs/updates.md §2).
///
/// ```dart
/// abstract class StoreMigration {
///   int get from; int get to;
///   void upgrade(Map<String, dynamic> data);   // in-place transform of the `data` blob
/// }
/// ```
///
/// `upgrade()` mutates the given map in place — it must never return a new
/// one. Two additive hooks with default implementations cover the key-space
/// operations the schema steps of §5 require (splitting `sessionState` per
/// profile, moving the legacy `theme` key into `appearance`, seeding
/// introduced keys); the per-blob `upgrade()` signature above stays exactly
/// as specified.
abstract class StoreMigration {
  /// The schema version this step migrates from.
  int get from;

  /// The schema version this step migrates to.
  int get to;

  /// In-place transform of the `data` blob (docs/updates.md §2). Mutate the
  /// map; do not return a new one. Only called when the payload is a JSON
  /// object — bare arrays and scalars have no internal structure to
  /// transform and pass through unchanged.
  void upgrade(Map<String, dynamic> data);

  /// Key-space effects of migrating [key] whose decoded payload is [data]
  /// (optional). Returns additional `{key: data}` writes the runner commits
  /// enveloped alongside this key's own migration. [lookup] reads the
  /// pre-migration snapshot of the other keys. Default: none.
  Map<String, Object?> sideKeys(String key, Object? data, StoreLookup lookup) =>
      const {};

  /// Keys this step introduces with default payloads (optional). The runner
  /// seeds them enveloped when absent after the chain reaches [to] — an
  /// existing value is never clobbered. Default: none.
  Map<String, Object?> introduced() => const {};
}

/// Read-only view of the store the steps consult while migrating one key.
///
/// The snapshot is taken before any key is transformed, so a step sees the
/// pre-migration state of the other keys.
abstract interface class StoreLookup {
  /// The decoded payload of [key], or null when the key is absent.
  Object? data(String key);

  /// Whether [key] has a stored value.
  bool exists(String key);
}
