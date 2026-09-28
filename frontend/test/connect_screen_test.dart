import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/jhin_client.dart';
import 'package:jhin/core/tls/tls_trust.dart';
import 'package:jhin/screens/connect_screen.dart';

import 'helpers/memory_token_storage.dart';

/// Валидный код: 26 символов Base32 (A-Z2-7) — как выдаёт backend.
const validCode = 'ABCDE2FGHIJKL2MNOPQRST2UVW';

/// Валидный фингерпринт формата `tls_trust` (32 байта hex парами через `:`).
final testFingerprint = formatFingerprint(List.generate(32, (i) => i));

/// Другой валидный фингерпринт — для сценария несовпадения (MITM).
final otherFingerprint = formatFingerprint(List.generate(32, (i) => 255 - i));

final jsonHeaders = {'content-type': 'application/json'};

http.Response enrollOk(http.Request request) => http.Response(
  '{"deviceToken":"token-abc123","accountId":"acc-1","accountName":"alice"}',
  200,
  headers: jsonHeaders,
);

http.Response healthOk(http.Request request) =>
    http.Response('{"status":"UP"}', 200, headers: jsonHeaders);

/// API-заглушка: `/health` → 200, `/enroll` → [enrollHandler]; все запросы
/// пишутся в [recorded].
http.Client mockApi(
  List<http.Request> recorded, {
  FutureOr<http.Response> Function(http.Request request)? enrollHandler,
}) {
  return MockClient((request) async {
    recorded.add(request);
    if (request.url.path == '/health') {
      return healthOk(request);
    }
    return (enrollHandler ?? enrollOk)(request);
  });
}

/// Как в `api_client_io`: «рукопожатие» зовёт [TrustStore.verify]; несовпадение
/// с пином → [TlsPinMismatchException].
http.Client tlsHandshakeClient(
  TrustStore trust,
  String fingerprint,
  List<http.Request> recorded, {
  FutureOr<http.Response> Function(http.Request request)? enrollHandler,
}) {
  return MockClient((request) async {
    if (!trust.verify(fingerprint)) {
      throw TlsPinMismatchException(
        fingerprint: fingerprint,
        pinnedFingerprint: trust.pinnedFingerprint,
      );
    }
    recorded.add(request);
    if (request.url.path == '/health') {
      return healthOk(request);
    }
    return (enrollHandler ?? enrollOk)(request);
  });
}

Widget wrap(ConnectScreen screen) => MaterialApp(home: screen);

Future<JhinClient> Function(Uri) fakeFactory({
  required MemoryTokenStorage storage,
  required TrustStore trust,
  required http.Client httpClient,
}) =>
    (uri) async => JhinClient(
      baseUrl: uri,
      storage: storage,
      trustStore: trust,
      httpClient: httpClient,
    );

Future<void> fillForm(
  WidgetTester tester, {
  String url = 'example.com:8443',
  String code = validCode,
  String deviceName = 'My Device',
}) async {
  await tester.enterText(find.byKey(const Key('field-server-url')), url);
  await tester.enterText(find.byKey(const Key('field-enroll-code')), code);
  await tester.enterText(
    find.byKey(const Key('field-device-name')),
    deviceName,
  );
}

/// Два pump'а: первый сливает microtask-цепочку (fake-http), второй —
/// догоняет анимации диалога. pumpAndSettle здесь не годится: пока TOFU-диалог
/// открыт, кнопка показывает CircularProgressIndicator (бесконечная анимация).
Future<void> flush(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 350));
}

Future<void> tapConnect(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('btn-connect')));
  await flush(tester);
}

void main() {
  group('нормализация/валидация', () {
    test('normalizeServerUrl добавляет https:// и срезает /', () {
      expect(
        normalizeServerUrl('example.com:8443'),
        'https://example.com:8443',
      );
      expect(
        normalizeServerUrl('  https://hub.example  '),
        'https://hub.example',
      );
      expect(
        normalizeServerUrl('http://hub.example:8443/'),
        'http://hub.example:8443',
      );
    });

    test('normalizeServerUrl отбрасывает мусор', () {
      expect(normalizeServerUrl(''), isNull);
      expect(normalizeServerUrl('   '), isNull);
      expect(normalizeServerUrl('https://'), isNull);
      expect(normalizeServerUrl('ftp://hub.example'), isNull);
      expect(normalizeServerUrl('http://'), isNull);
    });

    test('normalizeEnrollmentCode вырезает пробелы/дефисы и апперкейсит', () {
      expect(
        normalizeEnrollmentCode('abcde2-fghijkl2-mnopqrst2-uvw'),
        validCode,
      );
      expect(
        normalizeEnrollmentCode(' ABCDE2 FGH IJKL2-MNOPQRST2-UVW '),
        validCode,
      );
    });

    test('isValidEnrollmentCode: ровно 26 символов A-Z2-7', () {
      expect(isValidEnrollmentCode(validCode), isTrue);
      expect(isValidEnrollmentCode('A' * 25), isFalse);
      expect(isValidEnrollmentCode('A' * 27), isFalse);
      expect(isValidEnrollmentCode('A' * 25 + '1'), isFalse); // '1' не Base32
      expect(isValidEnrollmentCode('a' * 26), isFalse); // только UPPERCASE
    });
  });

  group('ConnectScreen', () {
    testWidgets('рендер формы: поля, кнопка, дефолтное device name', (
      tester,
    ) async {
      final recorded = <http.Request>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (_, _) {},
            clientFactory: fakeFactory(
              storage: MemoryTokenStorage(),
              trust: TrustStore(),
              httpClient: mockApi(recorded),
            ),
          ),
        ),
      );

      expect(find.text('Server URL'), findsOneWidget);
      expect(find.text('Enrollment code'), findsOneWidget);
      expect(find.text('Device name'), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);

      final deviceField = tester.widget<TextFormField>(
        find.byKey(const Key('field-device-name')),
      );
      expect(deviceField.controller!.text, startsWith('Flutter Client ('));
    });

    testWidgets('пустая форма: inline-ошибки, запросов нет', (tester) async {
      final recorded = <http.Request>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (_, _) {},
            clientFactory: fakeFactory(
              storage: MemoryTokenStorage(),
              trust: TrustStore(),
              httpClient: mockApi(recorded),
            ),
          ),
        ),
      );

      await tester.enterText(find.byKey(const Key('field-device-name')), ' ');
      await tapConnect(tester);

      expect(find.text('Укажите URL сервера'), findsOneWidget);
      expect(find.text('похоже, не тот формат'), findsOneWidget);
      expect(find.text('Укажите имя устройства'), findsOneWidget);
      expect(recorded, isEmpty);
    });

    testWidgets('невалидный URL: inline-ошибка, запросов нет', (tester) async {
      final recorded = <http.Request>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (_, _) {},
            clientFactory: fakeFactory(
              storage: MemoryTokenStorage(),
              trust: TrustStore(),
              httpClient: mockApi(recorded),
            ),
          ),
        ),
      );

      await fillForm(tester, url: 'https://');
      await tapConnect(tester);

      expect(find.text('Некорректный URL'), findsOneWidget);
      expect(find.text('похоже, не тот формат'), findsNothing);
      expect(recorded, isEmpty);
    });

    testWidgets('невалидный код: inline-ошибка, запросов нет', (tester) async {
      final recorded = <http.Request>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (_, _) {},
            clientFactory: fakeFactory(
              storage: MemoryTokenStorage(),
              trust: TrustStore(),
              httpClient: mockApi(recorded),
            ),
          ),
        ),
      );

      await fillForm(tester, code: 'short-code');
      await tapConnect(tester);

      expect(find.text('похоже, не тот формат'), findsOneWidget);
      expect(find.text('Некорректный URL'), findsNothing);
      expect(recorded, isEmpty);
    });

    testWidgets(
      'happy path: enroll с нормализованными полями, токен сохранён',
      (tester) async {
        final recorded = <http.Request>[];
        final storage = MemoryTokenStorage();
        final trust = TrustStore();
        final connected = <(JhinClient, EnrollResult)>[];
        await tester.pumpWidget(
          wrap(
            ConnectScreen(
              onConnected: (client, result) => connected.add((client, result)),
              clientFactory: fakeFactory(
                storage: storage,
                trust: trust,
                httpClient: mockApi(recorded),
              ),
            ),
          ),
        );

        await fillForm(
          tester,
          url: 'example.com:8443',
          code: 'abcde2-fghijkl2-mnopqrst2-uvw',
          deviceName: '  My Device  ',
        );
        await tapConnect(tester);

        final enrollRequests = recorded
            .where((r) => r.url.path == '/enroll')
            .toList();
        expect(enrollRequests, hasLength(1));
        final body =
            jsonDecode(enrollRequests.single.body) as Map<String, dynamic>;
        expect(body['code'], validCode);
        expect(body['deviceName'], 'My Device');

        expect(storage.token, 'token-abc123');
        expect(storage.serverUrl, 'https://example.com:8443');
        expect(storage.account?.accountId, 'acc-1');
        expect(storage.account?.accountName, 'alice');

        expect(connected, hasLength(1));
        expect(connected.single.$2.accountName, 'alice');
        expect(connected.single.$1.api.token, 'token-abc123');
        // fingerprint не было (fake без TLS) — диалога не было
        expect(find.text('Accept'), findsNothing);
      },
    );

    testWidgets('TOFU: диалог с fingerprint, Accept → pinCertificate', (
      tester,
    ) async {
      final recorded = <http.Request>[];
      final storage = MemoryTokenStorage();
      final trust = TrustStore();
      final connected = <(JhinClient, EnrollResult)>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (client, result) => connected.add((client, result)),
            clientFactory: fakeFactory(
              storage: storage,
              trust: trust,
              httpClient: tlsHandshakeClient(trust, testFingerprint, recorded),
            ),
          ),
        ),
      );

      await fillForm(tester);
      await tapConnect(tester);

      expect(find.text('Сертификат самоподписанный'), findsOneWidget);
      expect(
        find.text(
          'SHA-256 fingerprint: $testFingerprint\nПринять и запомнить?',
        ),
        findsOneWidget,
      );
      expect(recorded.where((r) => r.url.path == '/enroll'), isEmpty);

      await tester.tap(find.text('Accept'));
      await flush(tester);

      expect(trust.pinnedFingerprint, testFingerprint);
      expect(storage.pinnedFingerprint, testFingerprint);
      expect(recorded.where((r) => r.url.path == '/enroll'), hasLength(1));
      expect(connected, hasLength(1));
    });

    testWidgets('TOFU: Cancel → без пина, без enroll, форма на месте', (
      tester,
    ) async {
      final recorded = <http.Request>[];
      final storage = MemoryTokenStorage();
      final trust = TrustStore();
      final connected = <(JhinClient, EnrollResult)>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (client, result) => connected.add((client, result)),
            clientFactory: fakeFactory(
              storage: storage,
              trust: trust,
              httpClient: tlsHandshakeClient(trust, testFingerprint, recorded),
            ),
          ),
        ),
      );

      await fillForm(tester);
      await tapConnect(tester);

      expect(find.text('Cancel'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await flush(tester);

      expect(trust.pinnedFingerprint, isNull);
      expect(storage.pinnedFingerprint, isNull);
      expect(recorded.where((r) => r.url.path == '/enroll'), isEmpty);
      expect(connected, isEmpty);
      expect(find.byKey(const Key('btn-connect')), findsOneWidget);
    });

    testWidgets('уже запиненный совпавший fingerprint: диалога нет', (
      tester,
    ) async {
      final recorded = <http.Request>[];
      final storage = MemoryTokenStorage();
      final trust = TrustStore(pinnedFingerprint: testFingerprint);
      final connected = <(JhinClient, EnrollResult)>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (client, result) => connected.add((client, result)),
            clientFactory: fakeFactory(
              storage: storage,
              trust: trust,
              httpClient: tlsHandshakeClient(trust, testFingerprint, recorded),
            ),
          ),
        ),
      );

      await fillForm(tester);
      await tapConnect(tester);

      expect(find.text('Accept'), findsNothing);
      expect(find.text('Cancel'), findsNothing);
      expect(connected, hasLength(1));
    });

    testWidgets(
      'TlsPinMismatchException: жёсткая ошибка без «принять всё равно»',
      (tester) async {
        final recorded = <http.Request>[];
        final storage = MemoryTokenStorage();
        final trust = TrustStore(pinnedFingerprint: testFingerprint);
        final connected = <(JhinClient, EnrollResult)>[];
        await tester.pumpWidget(
          wrap(
            ConnectScreen(
              onConnected: (client, result) => connected.add((client, result)),
              clientFactory: fakeFactory(
                storage: storage,
                trust: trust,
                // «рукопожатие» предъявляет ДРУГОЙ сертификат → mismatch
                httpClient: tlsHandshakeClient(
                  trust,
                  otherFingerprint,
                  recorded,
                ),
              ),
            ),
          ),
        );

        await fillForm(tester);
        await tapConnect(tester);

        expect(find.text(tlsPinMismatchMessage), findsOneWidget);
        expect(find.text('Accept'), findsNothing);
        expect(find.text('Cancel'), findsNothing);
        expect(recorded.where((r) => r.url.path == '/enroll'), isEmpty);
        expect(connected, isEmpty);
      },
    );

    for (final (error, message, status) in [
      ('invalid_code', 'Код неверен', 400),
      ('code_used', 'Код уже использован', 400),
      ('code_expired', 'Код истёк', 400),
      ('bad_request', 'Некорректный запрос', 400),
      ('rate_limited', 'Слишком много попыток, подождите', 429),
    ]) {
      testWidgets('ошибка enroll $error → «$message»', (tester) async {
        final recorded = <http.Request>[];
        final connected = <(JhinClient, EnrollResult)>[];
        await tester.pumpWidget(
          wrap(
            ConnectScreen(
              onConnected: (client, result) => connected.add((client, result)),
              clientFactory: fakeFactory(
                storage: MemoryTokenStorage(),
                trust: TrustStore(),
                httpClient: mockApi(
                  recorded,
                  enrollHandler: (request) => http.Response(
                    '{"error":"$error"}',
                    status,
                    headers: jsonHeaders,
                  ),
                ),
              ),
            ),
          ),
        );

        await fillForm(tester);
        await tapConnect(tester);

        expect(find.text(message), findsOneWidget);
        expect(connected, isEmpty);
      });
    }

    testWidgets('сеть недоступна: «Сервер недоступен»', (tester) async {
      final connected = <(JhinClient, EnrollResult)>[];
      await tester.pumpWidget(
        wrap(
          ConnectScreen(
            onConnected: (client, result) => connected.add((client, result)),
            clientFactory: fakeFactory(
              storage: MemoryTokenStorage(),
              trust: TrustStore(),
              httpClient: MockClient((request) async {
                throw http.ClientException('connection refused');
              }),
            ),
          ),
        ),
      );

      await fillForm(tester);
      await tapConnect(tester);

      expect(find.text('Сервер недоступен'), findsOneWidget);
      expect(connected, isEmpty);
    });

    testWidgets(
      'web: fingerprint недоступен → пометка «TLS проверяется браузером»',
      (tester) async {
        final recorded = <http.Request>[];
        final connected = <(JhinClient, EnrollResult)>[];
        await tester.pumpWidget(
          wrap(
            ConnectScreen(
              browserTlsNote: true,
              onConnected: (client, result) => connected.add((client, result)),
              clientFactory: fakeFactory(
                storage: MemoryTokenStorage(),
                trust: TrustStore(),
                httpClient: mockApi(recorded),
              ),
            ),
          ),
        );

        await fillForm(tester);
        await tapConnect(tester);

        expect(find.text('TLS проверяется браузером'), findsOneWidget);
        expect(find.text('Accept'), findsNothing);
        expect(connected, hasLength(1));
        // доживаем snackbar-таймер, иначе testWidgets ругнется на pending timer
        await tester.pump(const Duration(seconds: 5));
      },
    );
  });
}
