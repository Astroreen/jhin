// Ручной e2e «два клиента — одна сессия» против реального backend'а (T29).
//
// Запуск:
//   1. JHIN_HOME=/tmp/opencode/jhin-t29-manual java -jar \
//        backend/build/libs/jhin-backend-*.jar --server.port=18443
//   2. java -jar ... admin create-account alice
//      java -jar ... admin create-enrollment alice   # код для device 1
//      java -jar ... admin create-enrollment alice   # код для device 2
//   3. JHIN_E2E_CODE1=<код1> JHIN_E2E_CODE2=<код2> \
//        [JHIN_E2E_URL=https://127.0.0.1:18443] \
//        devenv shell -- flutter test test/e2e_two_clients_manual_test.dart
//
// Без JHIN_E2E_CODE1/CODE2 тест пропускается (skip-guard).
// Токены не печатаются — только длины/валидность.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/jhin_client.dart';
import 'package:jhin/core/sse/sse_parser.dart';
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

/// Enroll и возврат клиента с device-токеном.
Future<JhinClient> enrollDevice(
  String serverUrl,
  String code,
  String deviceName,
) async {
  final storage = MemoryTokenStorage();
  final trust = TrustStore();
  final client = await JhinClient.create(
    baseUrl: Uri.parse(serverUrl),
    storage: storage,
    trustStore: trust,
  );
  await acceptTls(client);
  final result = await client.api.enroll(code: code, deviceName: deviceName);
  client.api.token = result.deviceToken;
  await storage.writeToken(result.deviceToken);
  stdout.writeln(
    'e2e: $deviceName enrolled; accountId=${result.accountId}; '
    'token-length=${result.deviceToken.length}',
  );
  return client;
}

void main() {
  final code1 = Platform.environment['JHIN_E2E_CODE1'] ??
      Platform.environment['JHIN_E2E_CODE'];
  final code2 = Platform.environment['JHIN_E2E_CODE2'];
  final serverUrl =
      Platform.environment['JHIN_E2E_URL'] ?? 'https://127.0.0.1:18443';

  final skip = (code1 == null || code1.isEmpty || code2 == null || code2.isEmpty)
      ? 'ручной e2e: задай JHIN_E2E_CODE1 и JHIN_E2E_CODE2'
      : false;

  test(
    'два клиента: одна сессия, одинаковые seq; resume с fromSeq=K+1',
    () async {
      // ── 1. Два устройства одного аккаунта ──────────────────────────────
      final client1 = await enrollDevice(serverUrl, code1!, 'T29 E2E Device 1');
      final client2 = await enrollDevice(serverUrl, code2!, 'T29 E2E Device 2');
      addTearDown(client1.close);
      addTearDown(client2.close);

      // ── 2. Provider (fake key — LLM упадёт, но события текут) ─────────
      final provider = await client1.api.createProvider(CreateProvider(
        name: 'T29 Fake',
        format: 'openai',
        apiKey: 'sk-fake-t29-e2e',
        model: 'gpt-4',
      ));
      stdout.writeln(
        'e2e: provider created; id-length=${provider.id.length}; '
        'model=${provider.model}',
      );

      // ── 3. Session ─────────────────────────────────────────────────────
      final session = await client1.api.createSession(CreateSession(
        title: 'T29 two-client test',
        workdir: '/tmp/opencode/jhin-t29-manual',
        model: provider.model,
        providerId: provider.id,
      ));
      stdout.writeln('e2e: session created; id-length=${session.id.length}');

      // ── 4. Оба подписались с fromSeq=0 ─────────────────────────────────
      final events1 = <SseEvent>[];
      final events2 = <SseEvent>[];
      final sub1 =
          client1.sessionEvents(session.id, fromSeq: 0).listen(events1.add);
      final sub2 =
          client2.sessionEvents(session.id, fromSeq: 0).listen(events2.add);
      addTearDown(sub1.cancel);
      addTearDown(sub2.cancel);

      await Future<void>.delayed(const Duration(milliseconds: 500));

      // ── 5. POST message с client1 ──────────────────────────────────────
      final runRef = await client1.api.sendMessage(session.id, 'hello from c1');
      stdout.writeln('e2e: message sent; runId-length=${runRef.runId?.length ?? 0}');

      // Ждём события: user_message + run_start + error/run_end (LLM fake).
      await Future<void>.delayed(const Duration(seconds: 8));

      // ── 6. Сверка seq ──────────────────────────────────────────────────
      final seqs1 = events1.map((e) => e.id).toList();
      final seqs2 = events2.map((e) => e.id).toList();
      stdout.writeln('e2e: client1 seq: $seqs1');
      stdout.writeln('e2e: client2 seq: $seqs2');
      stdout.writeln('e2e: client1 types: ${events1.map((e) => e.type).toList()}');
      stdout.writeln('e2e: client2 types: ${events2.map((e) => e.type).toList()}');

      expect(events1, isNotEmpty, reason: 'client1 не получил событий');
      expect(events2, isNotEmpty, reason: 'client2 не получил событий');
      expect(seqs1, equals(seqs2), reason: 'seq не совпали');
      expect(
        events1.map((e) => e.type).toList(),
        equals(events2.map((e) => e.type).toList()),
      );

      // user_message обязательно в ленте.
      expect(
        events1.where((e) => e.type == 'user_message'),
        hasLength(greaterThanOrEqualTo(1)),
      );

      // ── 7. Resume: fromSeq=K+1 отдаёт только новые ─────────────────────
      final lastId = seqs1.last ?? 0;
      final k = lastId - 1;
      final resumedEvents = <SseEvent>[];
      final resumeSub = client1
          .sessionEvents(session.id, fromSeq: k + 1)
          .listen(resumedEvents.add);
      await Future<void>.delayed(const Duration(seconds: 2));
      await resumeSub.cancel();

      final resumedSeqs = resumedEvents.map((e) => e.id).toList();
      stdout.writeln('e2e: resume fromSeq=${k + 1}; got seq: $resumedSeqs');
      stdout.writeln(
        'e2e: resume types: ${resumedEvents.map((e) => e.type).toList()}',
      );

      for (final seq in resumedSeqs) {
        if (seq != null) {
          expect(seq, greaterThanOrEqualTo(k + 1),
              reason: 'resume отдал seq=$seq < fromSeq=${k + 1}');
        }
      }
      expect(resumedEvents, isNotEmpty, reason: 'resume пуст');

      stdout.writeln('e2e: OK — два клиента получили идентичные seq, resume работает');
    },
    timeout: const Timeout(Duration(minutes: 2)),
    skip: skip,
  );
}
