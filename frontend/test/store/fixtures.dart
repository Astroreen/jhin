import 'dart:convert';

import 'package:jhin/core/auth/app_storage.dart';
import 'package:jhin/core/auth/string_store.dart';
import 'package:jhin/store/versioned_store.dart';

/// Real legacy (schema 1, un-enveloped) on-disk blobs — the shapes the
/// pre-envelope app wrote. Used by the runner tests and the T54 evidence
/// fixtures.
final String legacyProfilesRaw =
    '[{"id":"legacy-1","label":"Home","url":"https://jhin.example.org","certFingerprint":"${List.filled(32, 'AA').join(':')}"},'
    '{"id":"legacy-2","label":"Work","url":"https://work.example:8443"}]';

const String legacyActiveRaw = 'legacy-1';

const String legacySessionStateRaw =
    '{"stack":["screen:chat","screen:settings"],"cache":{"sidebar":"collapsed"}}';

const String legacyThemeRaw = '{"mode":"dark"}';

/// A schema-9 (future) envelope — newer than [StoreMigrations.current].
String futureProfilesRaw() => jsonEncode({
      'schema': 9,
      'app': '9.9.9',
      'writtenAt': '2026-10-03T09:30:00Z',
      'data': {
        'profiles': [
          {'id': 'future-1', 'label': 'Future'}
        ],
        'extra': true,
      },
    });

/// Seeds [prefs] with the full legacy (schema 1) on-disk state.
Future<void> seedLegacyStore(InMemoryStringStore prefs) async {
  await prefs.write(StoreKeys.profiles, legacyProfilesRaw);
  await prefs.write(StoreKeys.activeProfileId, legacyActiveRaw);
  await prefs.write(StoreKeys.legacySessionState, legacySessionStateRaw);
  await prefs.write(StoreKeys.legacyTheme, legacyThemeRaw);
}

/// A storage pair over in-memory backends.
AppStorage memoryStorage({
  InMemoryStringStore? prefs,
  InMemoryStringStore? secrets,
}) =>
    AppStorage(
      prefs: prefs ?? InMemoryStringStore(),
      secrets: secrets ?? InMemoryStringStore(),
    );

/// The decoded payload stored under [key] (assertion helper).
Object? payloadOf(InMemoryStringStore prefs, String key) =>
    decodeStoredValue(prefs.values[key])?.data;

/// The schema stored under [key] (assertion helper).
int? schemaOf(InMemoryStringStore prefs, String key) =>
    decodeStoredValue(prefs.values[key])?.schema;
