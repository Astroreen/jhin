import 'package:jhin/core/auth/token_storage.dart';

/// In-memory [TokenStorage] для widget-тестов connect-flow и ручного e2e.
class MemoryTokenStorage implements TokenStorage {
  String? token;
  String? serverUrl;
  String? pinnedFingerprint;
  StoredAccount? account;

  @override
  Future<String?> readToken() async => token;

  @override
  Future<void> writeToken(String value) async => token = value;

  @override
  Future<void> clearToken() async => token = null;

  @override
  Future<String?> readServerUrl() async => serverUrl;

  @override
  Future<void> writeServerUrl(String value) async => serverUrl = value;

  @override
  Future<void> clearServerUrl() async => serverUrl = null;

  @override
  Future<String?> readPinnedFingerprint() async => pinnedFingerprint;

  @override
  Future<void> writePinnedFingerprint(String value) async =>
      pinnedFingerprint = value;

  @override
  Future<void> clearPinnedFingerprint() async => pinnedFingerprint = null;

  @override
  Future<StoredAccount?> readAccount() async => account;

  @override
  Future<void> writeAccount(StoredAccount value) async => account = value;

  @override
  Future<void> clearAll() async {
    token = null;
    serverUrl = null;
    pinnedFingerprint = null;
    account = null;
  }
}
