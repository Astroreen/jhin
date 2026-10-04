import 'dart:convert';

/// App version stamped into every envelope's `app` field. Mirrors
/// `frontend/pubspec.yaml` (`version: 0.1.0+1`); the build number is not
/// part of the semver string.
const String kJhinAppVersion = '0.1.0';

/// The persisted-key envelope (docs/updates.md §1).
///
/// Every non-secure persisted key is stored as
/// `{"schema":int,"app":semver,"writtenAt":ISO-8601,"data":payload}`.
/// A stored value with **no** envelope is legacy `schema 1` (the current
/// on-disk shape): the raw value IS the data and it is wrapped and migrated
/// on first read (§3 rule 1). Malformed JSON never throws out of the store
/// API — it degrades to a legacy value carrying the raw string.
class StoredValue {
  const StoredValue({
    required this.schema,
    required this.app,
    required this.writtenAt,
    required this.data,
    required this.hasEnvelope,
  });

  /// Legacy `schema 1` view of a raw value (no envelope).
  factory StoredValue.legacy(Object? data) =>
      StoredValue(schema: 1, app: '', writtenAt: '', data: data, hasEnvelope: false);

  /// The persisted-data schema version the `data` blob was written at.
  final int schema;

  /// The app version that wrote the blob (empty for legacy values).
  final String app;

  /// ISO-8601 UTC timestamp of the write (empty for legacy values).
  final String writtenAt;

  /// The actual payload.
  final Object? data;

  /// Whether the raw value carried an envelope (false = legacy schema 1).
  final bool hasEnvelope;
}

/// Decodes one raw stored string into a [StoredValue].
///
/// - `null`/empty → no value at all (the key is absent).
/// - JSON object with an integer `schema` and a `data` field → enveloped.
/// - anything else (JSON array, JSON scalar, non-JSON garbage) → legacy
///   `schema 1`; the raw value IS the data. Malformed JSON never throws.
StoredValue? decodeStoredValue(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (_) {
    // Not JSON at all (e.g. a legacy bare string): the raw value IS data.
    return StoredValue.legacy(raw);
  }
  if (decoded is Map &&
      decoded['schema'] is int &&
      decoded.containsKey('data')) {
    final app = decoded['app'];
    final writtenAt = decoded['writtenAt'];
    return StoredValue(
      schema: decoded['schema'] as int,
      app: app is String ? app : '',
      writtenAt: writtenAt is String ? writtenAt : '',
      data: decoded['data'],
      hasEnvelope: true,
    );
  }
  // A value without an envelope is legacy schema 1 (§3 rule 1).
  return StoredValue.legacy(decoded);
}

/// Encodes [data] into the envelope format (docs/updates.md §1) with a
/// fresh `writtenAt` timestamp.
String encodeStoredValue({
  required int schema,
  required String app,
  required Object? data,
}) =>
    jsonEncode({
      'schema': schema,
      'app': app,
      'writtenAt': DateTime.now().toUtc().toIso8601String(),
      'data': data,
    });

/// The persisted key names the migration system owns (docs/updates.md §1).
///
/// The two pre-existing keys keep their on-disk `jhin.` prefix (that is the
/// real legacy shape in the wild); keys introduced by the schema steps use
/// the names of docs/updates.md §1 verbatim.
class StoreKeys {
  StoreKeys._();

  /// The server-profile list (legacy on-disk key, schema 1 shape: a bare
  /// JSON array of `ServerProfile` maps).
  static const String profiles = 'jhin.profiles';

  /// The active profile id (legacy on-disk key, schema 1 shape: a bare
  /// string).
  static const String activeProfileId = 'jhin.activeProfileId';

  /// The single-profile-era session state key (split per profile by 1→2).
  static const String legacySessionState = 'sessionState';

  /// The per-profile session state key (`screen stack + cache`).
  static String sessionState(String profileId) => 'sessionState:$profileId';

  /// Client appearance preferences (themeMode, textSize, density,
  /// panelMotionMs) — introduced at schema 3.
  static const String appearance = 'appearance';

  /// User keybinding override rules — introduced at schema 3.
  static const String keybindings = 'keybindings';

  /// Etag of the last-seen bootstrap `tokens` block — introduced at
  /// schema 3.
  static const String tokensEtag = 'tokensEtag';

  /// Command palette history.
  static const String paletteHistory = 'commands.paletteHistory';

  /// Per-profile sent-prompt history of the composer
  /// (`composer.history:<profileId>`) — introduced at the current schema
  /// (schema 3 envelope, no migration step needed).
  static String composerHistory(String profileId) => 'composer.history:$profileId';

  /// The legacy theme key migrated into `appearance` by 2→3.
  static const String legacyTheme = 'theme';

  /// The list of keys whose migration threw (§4).
  static const String quarantine = 'migration.quarantine';

  /// The raw pre-migration copy of one key (§4).
  static String backup(String key) => 'migration.backup:$key';

  /// The copy of a value written by a newer schema (§4, rule 3).
  static String quarantineCopy(String key, int schema) =>
      'migration.quarantine:$key:$schema';

  /// Whether [key] is migration bookkeeping (never migrated as data).
  static bool isBookkeeping(String key) =>
      key == quarantine ||
      key.startsWith('migration.backup:') ||
      key.startsWith('migration.quarantine:');
}
