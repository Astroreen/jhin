import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'string_store.dart';

/// Minimal KV interface over `flutter_secure_storage`, kept injectable so
/// tests can substitute an in-memory backend (platform channels are not
/// available under `flutter test`).
abstract interface class SecureStore {
  Future<void> write({required String key, required String? value});

  Future<String?> read({required String key});

  Future<void> delete({required String key});
}

/// Real backend: `flutter_secure_storage` (Keychain/Keystore/libsecret/Web
/// Crypto) — practical on every Jhin target platform.
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
}

/// [StringStore] adapter over [SecureStore] — the secret backend
/// (device tokens).
class SecureStringStore implements StringStore {
  SecureStringStore({SecureStore? store}) : _store = store ?? FlutterSecureStore();

  final SecureStore _store;

  @override
  Future<String?> read(String key) => _store.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _store.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _store.delete(key: key);
}