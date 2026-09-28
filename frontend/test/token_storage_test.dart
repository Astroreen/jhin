import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/auth/prefs_token_storage.dart';
import 'package:jhin/core/auth/secure_token_storage.dart';
import 'package:jhin/core/auth/token_storage.dart';
import 'package:jhin/core/tls/tls_trust.dart';
import 'package:shared_preferences/shared_preferences.dart';

class InMemorySecureStore implements SecureStore {
  final Map<String, String> data = {};

  @override
  Future<void> write({required String key, required String? value}) async {
    if (value == null) {
      data.remove(key);
    } else {
      data[key] = value;
    }
  }

  @override
  Future<String?> read({required String key}) async => data[key];

  @override
  Future<void> delete({required String key}) async {
    data.remove(key);
  }

  @override
  Future<void> deleteAll() async {
    data.clear();
  }
}

/// Фингерпринт валидного формата, собранный программно (без хардкода).
String fakeFingerprint() => formatFingerprint(List.generate(32, (i) => i));

Future<void> exercise(TokenStorage storage) async {
  expect(await storage.readToken(), isNull);
  await storage.writeToken('device-token-1');
  expect(await storage.readToken(), 'device-token-1');
  await storage.writeToken('device-token-2');
  expect(await storage.readToken(), 'device-token-2');
  await storage.clearToken();
  expect(await storage.readToken(), isNull);

  expect(await storage.readServerUrl(), isNull);
  await storage.writeServerUrl('https://hub.example:8443');
  expect(await storage.readServerUrl(), 'https://hub.example:8443');
  await storage.clearServerUrl();
  expect(await storage.readServerUrl(), isNull);

  final fingerprint = fakeFingerprint();
  expect(await storage.readPinnedFingerprint(), isNull);
  await storage.writePinnedFingerprint(fingerprint);
  expect(await storage.readPinnedFingerprint(), fingerprint);
  await storage.clearPinnedFingerprint();
  expect(await storage.readPinnedFingerprint(), isNull);

  expect(await storage.readAccount(), isNull);
  await storage.writeAccount(
    const StoredAccount(accountId: 'acc-1', accountName: 'alice'),
  );
  final account = await storage.readAccount();
  expect(account?.accountId, 'acc-1');
  expect(account?.accountName, 'alice');

  await storage.writeToken('t');
  await storage.writeServerUrl('https://hub');
  await storage.writePinnedFingerprint(fingerprint);
  await storage.writeAccount(
    const StoredAccount(accountId: 'acc-2', accountName: 'bob'),
  );
  await storage.clearAll();
  expect(await storage.readToken(), isNull);
  expect(await storage.readServerUrl(), isNull);
  expect(await storage.readPinnedFingerprint(), isNull);
  expect(await storage.readAccount(), isNull);
}

void main() {
  group('PrefsTokenStorage', () {
    test('write/read/clear (SharedPreferences.setMockInitialValues)', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      await exercise(PrefsTokenStorage());
    });

    test('хранит именно наши ключи с префиксом jhin.', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final storage = PrefsTokenStorage();
      await storage.writeToken('secret');
      await storage.writeServerUrl('https://hub');
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('jhin.deviceToken'), 'secret');
      expect(prefs.getString('jhin.serverUrl'), 'https://hub');
    });
  });

  group('SecureTokenStorage', () {
    test('write/read/clear через in-memory SecureStore', () async {
      final store = InMemorySecureStore();
      await exercise(SecureTokenStorage(store: store));
      expect(store.data, isEmpty);
    });

    test('ключи неймспейснуты jhin_', () async {
      final store = InMemorySecureStore();
      final storage = SecureTokenStorage(store: store);
      await storage.writeToken('secret');
      await storage.writePinnedFingerprint('fp');
      expect(store.data['jhin_deviceToken'], 'secret');
      expect(store.data['jhin_pinnedFingerprint'], 'fp');
    });

    test('платформенный путь через fake-канал FlutterSecureStorage', () async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      await exercise(SecureTokenStorage());
    });
  });
}
