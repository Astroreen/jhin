import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/jhin_transport.dart';

/// Failure QA: a 500 (and any non-2xx) surfaces as [JhinHttpException]
/// carrying both the status code and the raw body.
void main() {
  late HttpServer server;
  late JhinTransport transport;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final response = request.response;
      response.statusCode = HttpStatus.internalServerError;
      response.headers.contentType = ContentType.json;
      response.write(jsonEncode({'error': 'boom', 'message': 'kaboom'}));
      await response.close();
    });
    transport = JhinTransport(
      baseUrl: Uri.parse('http://127.0.0.1:${server.port}'),
    );
  });

  tearDown(() async {
    transport.close();
    await server.close(force: true);
  });

  group('TransportFailureTest', () {
    const body = '{"error":"boom","message":"kaboom"}';

    test('getJson 500 surfaces the status code and the body', () async {
      try {
        await transport.getJson('/fail');
        fail('expected JhinHttpException');
      } on JhinHttpException catch (error) {
        expect(error.statusCode, 500);
        expect(error.body, body);
        expect(error.errorCode, 'boom');
      }
    });

    test('postJson 500 surfaces the status code and the body', () async {
      try {
        await transport.postJson('/fail', {'a': 1});
        fail('expected JhinHttpException');
      } on JhinHttpException catch (error) {
        expect(error.statusCode, 500);
        expect(error.body, body);
        expect(error.errorCode, 'boom');
      }
    });

    test('health 500 surfaces the status code and the body', () async {
      try {
        await transport.health('http://127.0.0.1:${server.port}');
        fail('expected JhinHttpException');
      } on JhinHttpException catch (error) {
        expect(error.statusCode, 500);
        expect(error.body, body);
        expect(error.errorCode, 'boom');
      }
    });
  });
}