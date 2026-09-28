// Ручной e2e enrollment против реального backend'а (T28, QA без GUI).
//
// Запуск:
//   1. JHIN_HOME=/tmp/opencode/jhin-t28-manual java -jar \
//        backend/build/libs/jhin-backend-*.jar --server.port=18443
//   2. java -jar ... admin create-account alice
//      java -jar ... admin create-enrollment alice   # печатает код (26 символов)
//   3. JHIN_E2E_CODE=<код> [JHIN_E2E_URL=https://127.0.0.1:18443] \
//        devenv shell -- flutter test test/e2e_enroll_manual_test.dart
//
// Без JHIN_E2E_CODE тест пропускается (skip-guard). Токены не печатаются —
// только длины/валидность.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/jhin_client.dart';
import 'package:jhin/core/tls/tls_trust.dart';

import 'helpers/memory_token_storage.dart';

void main() {
  final code = Platform.environment['JHIN_E2E_CODE'];
  final serverUrl =
      Platform.environment['JHIN_E2E_URL'] ?? 'https://127.0.0.1:18443';

  test(
    'enroll по настоящему коду → 200 + токен; повторный → code_used',
    () async {
      final storage = MemoryTokenStorage();
      final trust = TrustStore();
      final client = await JhinClient.create(
        baseUrl: Uri.parse(serverUrl),
        storage: storage,
        trustStore: trust,
      );
      addTearDown(client.close);

      await client.api.health();
      final pending = trust.pendingFingerprint;
      stdout.writeln(
        'e2e: health OK; pending=${pending != null}; fp-length=${pending?.length ?? 0}',
      );
      expect(pending, isNotNull);
      expect(isValidFingerprint(pending!), isTrue);
      // Accept в TOFU-диалоге
      await client.pinCertificate(pending);
      expect(trust.isPinned, isTrue);

      final result = await client.api.enroll(
        code: code!,
        deviceName: 'Jhin T28 E2E',
      );
      stdout.writeln(
        'e2e: enroll OK; accountId=${result.accountId}; '
        'accountName=${result.accountName}; '
        'token-length=${result.deviceToken.length}',
      );
      expect(result.deviceToken, isNotEmpty);
      expect(result.accountId, isNotEmpty);
      expect(result.accountName, isNotEmpty);

      await client.storage.writeToken(result.deviceToken);
      expect(await storage.readToken(), result.deviceToken);

      try {
        await client.api.enroll(code: code, deviceName: 'Jhin T28 E2E');
        fail('повторный enroll должен был дать code_used');
      } on ApiClientException catch (error) {
        stdout.writeln(
          'e2e: повторный enroll → HTTP ${error.statusCode}; '
          'error=${error.error}',
        );
        expect(error.statusCode, 400);
        expect(error.error, 'code_used');
      }
    },
    skip: code == null
        ? 'ручной e2e: задай JHIN_E2E_CODE (и опц. JHIN_E2E_URL)'
        : false,
  );
}
