import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'token_storage.dart';

/// Минимальный KV-бэкенд секретов: нужен, чтобы подменять
/// `flutter_secure_storage` in-memory имплементацией в тестах.
abstract interface class SecureStore {
  Future<void> write({required String key, required String? value});

  Future<String?> read({required String key});

  Future<void> delete({required String key});

  Future<void> deleteAll();
}

/// Реальный бэкенд: `flutter_secure_storage` (Keychain/Keystore/libsecret).
class FlutterSecureStore implements SecureStore {
  FlutterSecureStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<void> write({required String key, required String? value}) =>
      _storage.write(key: key, value: value);

  @override
  Future<String?> read({required String key}) => _storage.read(key: key);

  @override
  Future<void> delete({required String key}) => _storage.delete(key: key);

  @override
  Future<void> deleteAll() => _storage.deleteAll();
}

/// [TokenStorage] поверх [SecureStore] (mobile/desktop).
class SecureTokenStorage implements TokenStorage {
  SecureTokenStorage({SecureStore? store})
    : _store = store ?? FlutterSecureStore();

  static const _tokenKey = 'jhin_deviceToken';
  static const _serverUrlKey = 'jhin_serverUrl';
  static const _fingerprintKey = 'jhin_pinnedFingerprint';
  static const _accountKey = 'jhin_account';

  final SecureStore _store;

  @override
  Future<String?> readToken() => _store.read(key: _tokenKey);

  @override
  Future<void> writeToken(String token) =>
      _store.write(key: _tokenKey, value: token);

  @override
  Future<void> clearToken() => _store.delete(key: _tokenKey);

  @override
  Future<String?> readServerUrl() => _store.read(key: _serverUrlKey);

  @override
  Future<void> writeServerUrl(String serverUrl) =>
      _store.write(key: _serverUrlKey, value: serverUrl);

  @override
  Future<void> clearServerUrl() => _store.delete(key: _serverUrlKey);

  @override
  Future<String?> readPinnedFingerprint() => _store.read(key: _fingerprintKey);

  @override
  Future<void> writePinnedFingerprint(String fingerprint) =>
      _store.write(key: _fingerprintKey, value: fingerprint);

  @override
  Future<void> clearPinnedFingerprint() => _store.delete(key: _fingerprintKey);

  @override
  Future<StoredAccount?> readAccount() async {
    final raw = await _store.read(key: _accountKey);
    if (raw == null) {
      return null;
    }
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) {
        return StoredAccount.fromJson(decoded);
      }
    } on FormatException {
      // повреждённое значение — считаем, что аккаунта нет
    } on TypeError {
      // неожиданные типы полей — то же
    }
    return null;
  }

  @override
  Future<void> writeAccount(StoredAccount account) =>
      _store.write(key: _accountKey, value: jsonEncode(account.toJson()));

  @override
  Future<void> clearAll() => _store.deleteAll();
}
