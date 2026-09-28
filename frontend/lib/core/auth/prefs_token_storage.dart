import 'dart:convert';

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
  static const _accountKey = 'jhin.account';

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
  Future<StoredAccount?> readAccount() async {
    final raw = (await _loader()).getString(_accountKey);
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
  Future<void> writeAccount(StoredAccount account) async {
    final prefs = await _loader();
    await prefs.setString(_accountKey, jsonEncode(account.toJson()));
  }

  @override
  Future<void> clearAll() async {
    final prefs = await _loader();
    await prefs.remove(_tokenKey);
    await prefs.remove(_serverUrlKey);
    await prefs.remove(_fingerprintKey);
    await prefs.remove(_accountKey);
  }
}
