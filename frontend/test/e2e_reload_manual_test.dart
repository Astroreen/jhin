// Ручной e2e reload против реального backend'а (T31).
//
// Запуск:
//   1. JHIN_HOME=/tmp/opencode/jhin-t31-manual java -jar \
//        backend/build/libs/jhin-backend-*.jar --server.port=18443
//      (для reload-сценария — под restart-loop, см. отчёт T31: процесс
//       завершается после 202 и стартует заново)
//   2. java -jar ... admin create-account alice
//      java -jar ... admin create-enrollment alice   # печатает код (26 символов)
//   3. JHIN_E2E_CODE=<код> [JHIN_E2E_URL=https://127.0.0.1:18443] \
//        devenv shell -- flutter test test/e2e_reload_manual_test.dart
//
// Сценарий: enroll → create provider (openai, fake key) → list →
// api.reload() → 202 → backend реально перезапускается (health-опрос с
// backoff до успеха) → device-токен прежний работает → list providers снова
// ок (SQLite пережил рестарт) → GET /ui/manifest (404 — норм до T32).
//
// Без JHIN_E2E_CODE тест пропускается (skip-guard). Токены/ключи не
// печатаются — только длины/валидность.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/jhin_client.dart';
import 'package:jhin/core/tls/tls_trust.dart';

import 'helpers/memory_token_storage.dart';

/// TOFU: принимает pending fingerprint (как Accept в диалоге).
Future<void> acceptTls(JhinClient client) async {
  await client.api.health();
  final pending = client.trustStore.pendingFingerprint;
  if (pending != null) {
    await client.pinCertificate(pending);
  }
}

void main() {
  final code = Platform.environment['JHIN_E2E_CODE'];
  final serverUrl =
      Platform.environment['JHIN_E2E_URL'] ?? 'https://127.0.0.1:18443';

  test(
    'reload: 202 → процесс перезапускается → токен и провайдеры живы',
    () async {
      final storage = MemoryTokenStorage();
      final trust = TrustStore();
      final client = await JhinClient.create(
        baseUrl: Uri.parse(serverUrl),
        storage: storage,
        trustStore: trust,
      );
      addTearDown(client.close);

      await acceptTls(client);
      final result = await client.api.enroll(
        code: code!,
        deviceName: 'Jhin T31 E2E',
      );
      client.api.token = result.deviceToken;
      await storage.writeToken(result.deviceToken);
      stdout.writeln(
        'e2e: enrolled accountName=${result.accountName}; '
        'token-length=${result.deviceToken.length}',
      );

      final created = await client.api.createProvider(const CreateProvider(
        name: 't31-e2e-provider',
        format: 'openai',
        apiKey: 'sk-t31-fake-key',
        model: 'gpt-4o-mini',
        baseUrl: 'https://openrouter.ai/api',
      ));
      stdout.writeln(
        'e2e: provider created id=${created.id}; '
        'format=${created.format}; model=${created.model}',
      );

      final before = await client.api.listProviders();
      expect(
        before.any((p) => p.id == created.id),
        isTrue,
        reason: 'create → list должен содержать нового провайдера',
      );
      stdout.writeln('e2e: list before reload → ${before.length} providers');

      final t0 = DateTime.now();
      final ack = await client.api.reload();
      stdout.writeln(
        'e2e: reload → status=${ack.status}; '
        'dt=${DateTime.now().difference(t0).inMilliseconds}ms',
      );
      expect(ack.status, 'restarting');

      // Процесс падает ~через 2с и поднимается заново (restart-loop):
      // даём осесть, затем health-опрос с backoff до первого успеха.
      await Future<void>.delayed(const Duration(seconds: 3));
      var alive = false;
      var attempts = 0;
      for (; attempts < 40; attempts++) {
        try {
          await client.api.health();
          alive = true;
          break;
        } on Exception catch (e) {
          stdout.writeln(
            'e2e: health attempt ${attempts + 1} failed (${e.runtimeType})',
          );
          await Future<void>.delayed(const Duration(milliseconds: 500));
        }
      }
      expect(alive, isTrue, reason: 'backend не поднялся после reload');
      stdout.writeln(
        'e2e: backend alive after ${attempts + 1} health attempts; '
        'total=${DateTime.now().difference(t0).inSeconds}s',
      );

      // Токен прежний работает (не ротируется при рестарте).
      expect(client.api.token, result.deviceToken);
      final after = await client.api.listProviders();
      stdout.writeln('e2e: list after restart → ${after.length} providers');
      expect(
        after.any((p) => p.id == created.id && p.name == 't31-e2e-provider'),
        isTrue,
        reason: 'провайдеры должны пережить рестарт (SQLite)',
      );

      // Manifest nullable (404 до T32) — перечитываем, не падаем.
      final manifest = await client.api.getUiManifest();
      stdout.writeln('e2e: ui manifest present=${manifest != null}');
    },
    skip: code == null
        ? 'ручной e2e: задай JHIN_E2E_CODE (и опц. JHIN_E2E_URL)'
        : false,
  );
}