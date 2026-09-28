import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jhin/core/auth/token_storage.dart';
import 'package:jhin/core/jhin_client.dart';
import 'package:jhin/core/tls/tls_trust.dart';
import 'package:jhin/screens/settings_screen.dart';

import 'helpers/memory_token_storage.dart';

/// Валидный фингерпринт формата `tls_trust` (32 байта hex парами через `:`).
final testFingerprint = formatFingerprint(List.generate(32, (i) => i));

final providerRecord = <String, dynamic>{
  'id': 'prov-1',
  'accountId': 'acc-1',
  'name': 'OpenRouter',
  'format': 'openai',
  'model': 'gpt-4o',
  'baseUrl': 'https://openrouter.ai/api',
  'isDefault': true,
};

/// JhinClient поверх MockClient: маршрутизация по path+method, запросы
/// пишутся в [log]. Секреты никогда не возвращаются (как настоящий API).
///
/// [reloadManual] — 503 `restart manually` (dev-режим backend'а);
/// [healthFailures] — сколько раз `GET /health» упадёт до успеха (обрыв
/// во время рестарта).
JhinClient mockClient(
  List<(String method, String path, String body)> log, {
  List<Map<String, dynamic>>? providers,
  bool reloadManual = false,
  int healthFailures = 0,
  TrustStore? trust,
  TokenStorage? storage,
}) {
  final records = providers ?? [];
  var failures = healthFailures;
  final httpClient = MockClient((request) async {
    log.add((request.method, request.url.path, request.body));
    final path = request.url.path;
    final method = request.method;
    final headers = {'content-type': 'application/json'};
    if (method == 'GET' && path == '/providers') {
      return http.Response(jsonEncode(records), 200, headers: headers);
    }
    if (method == 'POST' && path == '/providers') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      if (body['name'] == null ||
          body['apiKey'] == null ||
          body['model'] == null) {
        return http.Response('{"error":"bad_request"}', 400, headers: headers);
      }
      if (!providerFormats.contains(body['format'])) {
        return http.Response(
          '{"error":"unknown_format"}',
          400,
          headers: headers,
        );
      }
      final record = <String, dynamic>{
        'id': 'prov-new',
        'accountId': 'acc-1',
        'name': body['name'],
        'format': body['format'],
        'model': body['model'],
        'baseUrl': body['baseUrl'],
        'isDefault': body['isDefault'] ?? false,
      };
      records.add(record);
      return http.Response(jsonEncode(record), 201, headers: headers);
    }
    if (method == 'DELETE' && path.startsWith('/providers/')) {
      final id = path.substring('/providers/'.length);
      records.removeWhere((p) => p['id'] == id);
      return http.Response('', 204, headers: headers);
    }
    if (method == 'POST' && path == '/admin/reload') {
      if (reloadManual) {
        return http.Response(
          '{"error":"restart manually"}',
          503,
          headers: headers,
        );
      }
      return http.Response('{"status":"restarting"}', 202, headers: headers);
    }
    if (method == 'GET' && path == '/health') {
      if (failures > 0) {
        failures--;
        return http.Response('down', 503, headers: headers);
      }
      return http.Response('{"status":"UP"}', 200, headers: headers);
    }
    return http.Response('{"error":"not_found"}', 404, headers: headers);
  });
  return JhinClient(
    baseUrl: Uri.parse('https://test'),
    storage: storage ?? MemoryTokenStorage(),
    trustStore: trust ?? TrustStore(),
    httpClient: httpClient,
  );
}

/// Экран под тестом: мгновенные паузы reload-flow (без pending-таймеров).
Widget wrap(SettingsScreen screen) => MaterialApp(home: screen);

SettingsScreen settings(
  JhinClient client, {
  VoidCallback? onSignedOut,
}) =>
    SettingsScreen(
      client: client,
      onSignedOut: onSignedOut ?? () {},
      delay: (_) async {},
    );

/// Снекбар живёт 4с — доводим таймер до срабатывания, чтобы тест не упал
/// на pending Timer.
Future<void> flushSnackbars(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 5));
  await tester.pumpAndSettle();
}

Future<void> openForm(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('btn-add-provider')));
  await tester.pumpAndSettle();
}

void main() {
  group('SettingsScreen: провайдеры', () {
    testWidgets('карточка провайдера; apiKey не показывается никогда', (
      tester,
    ) async {
      final log = <(String, String, String)>[];
      final client = mockClient(log, providers: [Map.of(providerRecord)]);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();

      expect(find.text('OpenRouter'), findsOneWidget);
      expect(find.textContaining('openai · gpt-4o'), findsOneWidget);
      expect(find.textContaining('https://openrouter.ai/api'), findsOneWidget);
      expect(find.text('по умолчанию'), findsOneWidget);
      // Секрет не участвует в DTO и не рендерится: маска/ключ не встречаются.
      expect(find.textContaining('sk-'), findsNothing);
      expect(find.textContaining('apiKey'), findsNothing);
    });

    testWidgets('пустое состояние', (tester) async {
      final client = mockClient([]);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('text-no-providers')), findsOneWidget);
    });

    testWidgets('форма create: POST /providers со всеми полями', (tester) async {
      final log = <(String, String, String)>[];
      final client = mockClient(log);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();

      await openForm(tester);
      await tester.enterText(
        find.byKey(const Key('field-provider-name')),
        'Ollama',
      );
      await tester.tap(find.byKey(const Key('dropdown-provider-format')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('openai').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('field-provider-base-url')),
        'http://localhost:11434/v1',
      );
      await tester.enterText(
        find.byKey(const Key('field-provider-api-key')),
        'ollama-local-key',
      );
      await tester.enterText(
        find.byKey(const Key('field-provider-model')),
        'qwen3',
      );
      await tester.tap(find.byKey(const Key('switch-provider-default')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('btn-create-provider')));
      await tester.pumpAndSettle();

      final creates = log.where((e) => e.$1 == 'POST' && e.$2 == '/providers');
      expect(creates, hasLength(1));
      final body = jsonDecode(creates.single.$3) as Map<String, dynamic>;
      expect(body['name'], 'Ollama');
      expect(body['format'], 'openai');
      expect(body['model'], 'qwen3');
      expect(body['baseUrl'], 'http://localhost:11434/v1');
      expect(body['isDefault'], isTrue);
      // Секрет уходит только в create-запрос, после сохранения не рендерится.
      expect(body['apiKey'], 'ollama-local-key');
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('Ollama'), findsOneWidget);
    });

    testWidgets('форма create: пустые обязательные поля → ошибка, POST нет', (
      tester,
    ) async {
      final log = <(String, String, String)>[];
      final client = mockClient(log);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();

      await openForm(tester);
      await tester.tap(find.byKey(const Key('btn-create-provider')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('text-provider-form-error')), findsOneWidget);
      expect(log.where((e) => e.$1 == 'POST'), isEmpty);
    });

    testWidgets('формат-dropdown: anthropic|openai|gemini', (tester) async {
      final client = mockClient([]);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();

      await openForm(tester);
      await tester.tap(find.byKey(const Key('dropdown-provider-format')));
      await tester.pumpAndSettle();

      expect(find.text('anthropic'), findsWidgets);
      expect(find.text('openai'), findsOneWidget);
      expect(find.text('gemini'), findsOneWidget);
    });

    testWidgets('delete: confirm → DELETE /providers/{id}, карточка исчезает', (
      tester,
    ) async {
      final log = <(String, String, String)>[];
      final client = mockClient(log, providers: [Map.of(providerRecord)]);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('btn-delete-provider-prov-1')));
      await tester.pumpAndSettle();
      expect(find.text('Удалить провайдера?'), findsOneWidget);
      await tester.tap(find.byKey(const Key('btn-confirm-delete-provider')));
      await tester.pumpAndSettle();

      final deletes = log.where((e) => e.$1 == 'DELETE');
      expect(deletes, hasLength(1));
      expect(deletes.single.$2, '/providers/prov-1');
      expect(find.text('OpenRouter'), findsNothing);
    });
  });

  group('SettingsScreen: reload', () {
    testWidgets('202: reload → health → перечитал providers + manifest', (
      tester,
    ) async {
      final log = <(String, String, String)>[];
      final client = mockClient(log, providers: [Map.of(providerRecord)]);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();
      log.clear();

      await tester.tap(find.byKey(const Key('btn-reload')));
      await tester.pumpAndSettle();
      expect(find.text('Клиент переподключится автоматически.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('btn-confirm-reload')));
      await tester.pumpAndSettle();

      final paths = [for (final e in log) e.$2];
      expect(paths, containsAllInOrder([
        '/admin/reload',
        '/health',
        '/providers',
        '/ui/manifest',
      ]));
      expect(find.text('Backend перезапущен'), findsOneWidget);
      expect(find.byKey(const Key('btn-reload')), findsOneWidget);
      await flushSnackbars(tester);
    });

    testWidgets('202: переживает обрыв — health падает и поднимается', (
      tester,
    ) async {
      final log = <(String, String, String)>[];
      final client = mockClient(
        log,
        providers: [Map.of(providerRecord)],
        healthFailures: 3,
      );
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();
      log.clear();

      await tester.tap(find.byKey(const Key('btn-reload')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('btn-confirm-reload')));
      await tester.pumpAndSettle();

      final healthCalls = log.where((e) => e.$2 == '/health');
      expect(healthCalls, hasLength(4)); // 3 падения + 1 успех
      expect(find.text('Backend перезапущен'), findsOneWidget);
      await flushSnackbars(tester);
    });

    testWidgets('503 restart manually → snackbar «вручную»', (tester) async {
      final log = <(String, String, String)>[];
      final client = mockClient(log, reloadManual: true);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();
      log.clear();

      await tester.tap(find.byKey(const Key('btn-reload')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('btn-confirm-reload')));
      await tester.pumpAndSettle();

      expect(find.textContaining('вручную'), findsOneWidget);
      expect(log.where((e) => e.$2 == '/health'), isEmpty);
      await flushSnackbars(tester);
    });
  });

  group('SettingsScreen: устройство', () {
    testWidgets('закреплённый пин показан; без пина — «Не закреплён»', (
      tester,
    ) async {
      final trust = TrustStore()..pin(testFingerprint);
      final client = mockClient([], trust: trust);
      addTearDown(client.close);
      await tester.pumpWidget(wrap(settings(client)));
      await tester.pumpAndSettle();

      expect(find.text(testFingerprint), findsOneWidget);
      expect(testFingerprint, hasLength(95));
      expect(find.byKey(const Key('text-pin-none')), findsNothing);

      final untrusted = mockClient([]);
      addTearDown(untrusted.close);
      await tester.pumpWidget(wrap(settings(untrusted)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('text-pin-none')), findsOneWidget);
    });

    testWidgets('забыть токен: confirm → signOut + onSignedOut', (tester) async {
      final storage = MemoryTokenStorage()
        ..token = 'device-token-abc123'
        ..pinnedFingerprint = testFingerprint;
      final trust = TrustStore()..pin(testFingerprint);
      final client = mockClient([], storage: storage, trust: trust);
      addTearDown(client.close);
      var signedOut = false;
      await tester.pumpWidget(
        wrap(settings(client, onSignedOut: () => signedOut = true)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('btn-forget-token')));
      await tester.pumpAndSettle();
      expect(find.text('Забыть токен?'), findsOneWidget);
      await tester.tap(find.byKey(const Key('btn-confirm-forget')));
      await tester.pumpAndSettle();

      expect(signedOut, isTrue);
      expect(storage.token, isNull);
      expect(storage.pinnedFingerprint, isNull);
      expect(trust.pinnedFingerprint, isNull);
    });
  });
}
