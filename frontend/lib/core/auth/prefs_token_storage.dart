import 'package:shared_preferences/shared_preferences.dart';

import 'token_storage.dart';

/// [TokenStorage] поверх `shared_preferences`: web (основной сценарий) и
/// фолбэк там, где secure storage недоступен. Токен на web хранится в
/// localStorage браузера — честно: это не secure storage; web-режим доверяет
/// браузерной изоляции.
class PrefsTokenStorage implements TokenStorage {
  PrefsTokenStorage({Future<SharedPreferences> Function()? loader})
      : _loader = loader ?? SharedPreferences.getInstance;

  static const _tokenKey = 'jhin.deviceToken';
  static const _serverUrlKey = 'jhin.serverUrl';
  static const _fingerprintKey = 'jhin.pinnedFingerprint';

  final Future<SharedPreferences> Function() _loader;

  @override
  Future<String?> readToken() async => (await _loader()).getString(_tokenKey);

  @override
  Future<void> writeToken(String token) async {
    final prefs = await _loader();
    await prefs.setString(_tokenKey, token);
  }

  @override
  Future<void> clearToken() async {
    final prefs = await _loader();
    await prefs.remove(_tokenKey);
  }

  @override
  Future<String?> readServerUrl() async =>
      (await _loader()).getString(_serverUrlKey);

  @override
  Future<void> writeServerUrl(String serverUrl) async {
    final prefs = await _loader();
    await prefs.setString(_serverUrlKey, serverUrl);
  }

  @override
  Future<void> clearServerUrl() async {
    final prefs = await _loader();
    await prefs.remove(_serverUrlKey);
  }

  @override
  Future<String?> readPinnedFingerprint() async =>
      (await _loader()).getString(_fingerprintKey);

  @override
  Future<void> writePinnedFingerprint(String fingerprint) async {
    final prefs = await _loader();
    await prefs.setString(_fingerprintKey, fingerprint);
  }

  @override
  Future<void> clearPinnedFingerprint() async {
    final prefs = await _loader();
    await prefs.remove(_fingerprintKey);
  }

  @override
  Future<void> clearAll() async {
    final prefs = await _loader();
    await prefs.remove(_tokenKey);
    await prefs.remove(_serverUrlKey);
    await prefs.remove(_fingerprintKey);
  }
}
