import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/tls/tls_trust.dart';

/// SPIKE T27: `X509Certificate.der` в Dart 3.13 отдаёт DER-байты сертификата
/// напрямую (PEM-парсинг не нужен) → SHA-256 → фингерпринт в формате backend'а.
///
/// Мини-интеграция: `HttpServer.bindSecure` с самоподписанным сертом из
/// фикстур + `badCertificateCallback`. Фикстуры — test-only ключи
/// (никогда не деплоить); эталонные фингерпринты `*.sha256` посчитаны openssl
/// при генерации и сверяются с `certFingerprint(cert.der)`.
void main() {
  late HttpServer server;
  late HttpClient client;
  late Uint8List? seenDer;
  late TrustStore trust;

  Uint8List fixtureDer(String name) {
    final pem = File('test/fixtures/tls/$name.pem').readAsStringSync();
    final body = pem
        .split('\n')
        .where((line) =>
            !line.startsWith('-----') && line.trim().isNotEmpty)
        .join();
    return Uint8List.fromList(base64.decode(body));
  }

  String fixtureFingerprint(String name) =>
      File('test/fixtures/tls/$name.sha256').readAsStringSync().trim();

  setUp(() async {
    seenDer = null;
    trust = TrustStore();
    final context = SecurityContext()
      ..useCertificateChain('test/fixtures/tls/server1.pem')
      ..usePrivateKey('test/fixtures/tls/server1.key');
    server = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      context,
    );
    server.listen((request) async {
      request.response.write('ok');
      await request.response.close();
    });
    client = HttpClient()
      ..badCertificateCallback = (cert, host, port) {
        seenDer = cert.der;
        return trust.verify(certFingerprint(cert.der));
      };
  });

  tearDown(() async {
    client.close(force: true);
    await server.close(force: true);
  });

  Uri secureUri(int port) =>
      Uri(scheme: 'https', host: InternetAddress.loopbackIPv4.address, port: port);

  test('cert.der == DER из PEM-фикстуры; фингерпринт == openssl-sha256',
      () async {
    final request = await client.getUrl(secureUri(server.port).replace(path: '/'));
    final response = await request.close();
    final body = await response.transform(utf8.decoder).join();
    expect(body, 'ok');

    expect(seenDer, isNotNull, reason: 'badCertificateCallback должен сработать');
    expect(seenDer, fixtureDer('server1'),
        reason: 'cert.der — та же DER-кодировка, что в PEM');

    final fingerprint = certFingerprint(seenDer!);
    expect(fingerprint, fixtureFingerprint('server1'),
        reason: 'SHA-256 формат совпадает с openssl x509 -fingerprint -sha256');
    expect(isValidFingerprint(fingerprint), isTrue);
    expect(fingerprint, hasLength(95));
  });

  test('TOFU: первый контакт → pending; после pin смена серта → handshake fail',
      () async {
    // 1) первый контакт принимается, фингерпринт запоминается как pending
    final request = await client.getUrl(secureUri(server.port).replace(path: '/'));
    final response = await request.close();
    await response.drain<void>();
    expect(trust.isPinned, isFalse);
    expect(trust.pendingFingerprint, fixtureFingerprint('server1'));

    // 2) пользователь подтверждает → пин
    trust.pin(trust.pendingFingerprint!);

    // 3) «смена серта»: сервер с другим самоподписанным сертом → отказ
    final context2 = SecurityContext()
      ..useCertificateChain('test/fixtures/tls/server2.pem')
      ..usePrivateKey('test/fixtures/tls/server2.key');
    final server2 = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      context2,
    );
    server2.listen((request) async {
      request.response.write('mitm');
      await request.response.close();
    });
    addTearDown(() => server2.close(force: true));

    await expectLater(
      client.getUrl(secureUri(server2.port).replace(path: '/')),
      throwsA(isA<HandshakeException>()),
    );
    expect(trust.rejectedFingerprint, fixtureFingerprint('server2'));
  });
}
