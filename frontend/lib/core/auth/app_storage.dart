import 'dart:math' as math;

import '../../store/migrations/store_migrations.dart';
import '../../store/versioned_store.dart';
import 'prefs_store.dart';
import 'secure_store.dart';
import 'string_store.dart';

/// A Jhin server profile (client-owned, D-9).
///
/// Record shape: `{id, label, url, certFingerprint, token?, cachedBootstrap?,
/// cachedScreens?, fallbacks?}`. [certFingerprint] is null until the first
/// successful TOFU handshake — and stays null on web, where the browser never
/// exposes the peer certificate.
class ServerProfile {
  const ServerProfile({
    required this.id,
    required this.label,
    required this.url,
    this.certFingerprint,
    this.token,
    this.cachedBootstrap,
    this.cachedScreens,
    this.fallbacks,
  });

  factory ServerProfile.fromJson(Map<String, dynamic> json) => ServerProfile(
        id: json['id'] as String,
        label: json['label'] as String,
        url: json['url'] as String,
        certFingerprint: json['certFingerprint'] as String?,
        token: json['token'] as String?,
        cachedBootstrap: _map(json['cachedBootstrap']),
        cachedScreens: _map(json['cachedScreens']),
        fallbacks: _map(json['fallbacks']),
      );

  final String id;
  final String label;
  final String url;
  final String? certFingerprint;
  final String? token;
  final Map<String, dynamic>? cachedBootstrap;
  final Map<String, dynamic>? cachedScreens;
  final Map<String, dynamic>? fallbacks;

  ServerProfile copyWith({
    String? label,
    String? url,
    String? certFingerprint,
    String? token,
    Map<String, dynamic>? cachedBootstrap,
    Map<String, dynamic>? cachedScreens,
    Map<String, dynamic>? fallbacks,
  }) =>
      ServerProfile(
        id: id,
        label: label ?? this.label,
        url: url ?? this.url,
        certFingerprint: certFingerprint ?? this.certFingerprint,
        token: token ?? this.token,
        cachedBootstrap: cachedBootstrap ?? this.cachedBootstrap,
        cachedScreens: cachedScreens ?? this.cachedScreens,
        fallbacks: fallbacks ?? this.fallbacks,
      );

  /// Serializes the profile; [includeToken] is false for the prefs backend
  /// (tokens live in the secure backend, keyed by profile id).
  Map<String, Object?> toJson({bool includeToken = true}) => {
        'id': id,
        'label': label,
        'url': url,
        'certFingerprint': certFingerprint,
        if (includeToken) 'token': token,
        if (cachedBootstrap != null) 'cachedBootstrap': cachedBootstrap,
        if (cachedScreens != null) 'cachedScreens': cachedScreens,
        if (fallbacks != null) 'fallbacks': fallbacks,
      };

  static Map<String, dynamic>? _map(Object? value) =>
      value is Map<String, dynamic> ? value : null;
}

/// Persistent app storage: server profiles plus the active profile id.
///
/// Backend split: profiles and `activeProfileId` live in the prefs backend
/// (JSON), device tokens live in the secure backend keyed `jhin.profileToken.<id>`
/// — a prefs dump therefore never contains secrets. Both backends are
/// injectable ([StringStore]); production wires [PrefsStringStore] +
/// [SecureStringStore], tests use [InMemoryStringStore].
class AppStorage {
  AppStorage({StringStore? prefs, StringStore? secrets})
      : _prefs = prefs ?? PrefsStringStore(),
        _secrets = secrets ?? SecureStringStore();

  static const _profilesKey = StoreKeys.profiles;
  static const _activeProfileKey = StoreKeys.activeProfileId;
  static const _tokenKeyPrefix = 'jhin.profileToken.';

  final StringStore _prefs;
  final StringStore _secrets;
  final math.Random _random = math.Random();

  /// Raw access to the non-secure backend — the migration runner's channel
  /// for backups (`migration.backup:<key>`), quarantine copies and
  /// enveloped commits (docs/updates.md §3). Raw values are stored verbatim.
  Future<String?> readRaw(String key) => _prefs.read(key);

  Future<void> writeRaw(String key, String value) => _prefs.write(key, value);

  Future<void> deleteKey(String key) => _prefs.delete(key);

  /// Writes [data] enveloped at the current schema (docs/updates.md §1).
  /// Every non-secure key goes through this — profiles,
  /// `activeProfileId`, `sessionState:<profileId>`, `appearance`,
  /// `keybindings`, `commands.paletteHistory`, `migration.quarantine`.
  /// The secure backend is never enveloped.
  Future<void> writeEnvelope(
    String key,
    Object? data, {
    int? schema,
    String? app,
  }) =>
      _prefs.write(
        key,
        encodeStoredValue(
          schema: schema ?? StoreMigrations.current,
          app: app ?? kJhinAppVersion,
          data: data,
        ),
      );

  /// Reads [key]'s enveloped payload (or its legacy schema-1 value); null
  /// when the key is absent. Malformed values never throw — they surface as
  /// the raw legacy string.
  Future<Object?> readData(String key) async =>
      decodeStoredValue(await _prefs.read(key))?.data;

  /// All stored profiles (tokens hydrated from the secure backend).
  /// Malformed stored values degrade to an empty list — never throws.
  Future<List<ServerProfile>> readProfiles() async {
    final raw = await _prefs.read(_profilesKey);
    if (raw == null || raw.isEmpty) {
      return const [];
    }
    try {
      final data = decodeStoredValue(raw)?.data;
      final items = data is List ? data : const [];
      final profiles = <ServerProfile>[];
      for (final item in items) {
        if (item is! Map<String, dynamic>) {
          continue;
        }
        try {
          final profile = ServerProfile.fromJson(item);
          final token = await _secrets.read(_tokenKeyPrefix + profile.id);
          profiles.add(token == null ? profile : profile.copyWith(token: token));
        } catch (_) {
          // Malformed profile entry: skip it, never throw out of the store.
        }
      }
      return profiles;
    } catch (_) {
      return const [];
    }
  }

  /// Appends a new profile and persists it. Does not change the active
  /// profile — switching is explicit ([setActiveProfileId]).
  Future<ServerProfile> addProfile({
    required String label,
    required String url,
    String? certFingerprint,
    String? token,
  }) async {
    final profile = ServerProfile(
      id: _newId(),
      label: label,
      url: url,
      certFingerprint: certFingerprint,
      token: token,
    );
    final profiles = await readProfiles();
    await _saveProfiles([...profiles, profile]);
    await _writeToken(profile);
    return profile;
  }

  /// Replaces the profile with the same id (label/url/caches/token).
  Future<void> updateProfile(ServerProfile profile) async {
    final profiles = await readProfiles();
    final updated = [
      for (final item in profiles) item.id == profile.id ? profile : item,
    ];
    await _saveProfiles(updated);
    await _writeToken(profile);
  }

  /// Removes a profile and its token; clears `activeProfileId` when it was
  /// the active one.
  Future<void> removeProfile(String id) async {
    final profiles = await readProfiles();
    await _saveProfiles([for (final p in profiles) if (p.id != id) p]);
    await _secrets.delete(_tokenKeyPrefix + id);
    if (await readActiveProfileId() == id) {
      await setActiveProfileId(null);
    }
  }

  /// The active profile id, or null when none is selected. Reads both the
  /// enveloped form and the legacy bare-string form; broken-JSON garbage
  /// degrades to null — never throws.
  Future<String?> readActiveProfileId() async {
    final raw = await _prefs.read(_activeProfileKey);
    final stored = decodeStoredValue(raw);
    if (stored == null) return null;
    if (!stored.hasEnvelope && raw != null && _looksLikeBrokenJson(raw)) {
      return null;
    }
    final data = stored.data;
    return data is String && data.isNotEmpty ? data : null;
  }

  /// Legacy bare-string values never start with a JSON structural char;
  /// anything that does is broken JSON, not an id.
  static bool _looksLikeBrokenJson(String raw) {
    final first = raw.trimLeft().isEmpty ? '' : raw.trimLeft()[0];
    return first == '{' || first == '[';
  }

  /// Selects the active profile (persisted enveloped); null clears it.
  Future<void> setActiveProfileId(String? id) async {
    if (id == null) {
      await _prefs.delete(_activeProfileKey);
      return;
    }
    await writeEnvelope(_activeProfileKey, id);
  }

  Future<void> _saveProfiles(List<ServerProfile> profiles) async {
    await writeEnvelope(
        _profilesKey, [for (final p in profiles) p.toJson(includeToken: false)]);
  }

  Future<void> _writeToken(ServerProfile profile) async {
    final key = _tokenKeyPrefix + profile.id;
    final token = profile.token;
    if (token == null || token.isEmpty) {
      await _secrets.delete(key);
      return;
    }
    await _secrets.write(key, token);
  }

  String _newId() {
    final stamp = DateTime.now().microsecondsSinceEpoch.toRadixString(16);
    final salt = _random.nextInt(0xFFFFFF).toRadixString(16).padLeft(6, '0');
    return '$stamp-$salt';
  }
}