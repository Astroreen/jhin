import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/jhin_transport.dart';
import 'package:jhin/core/sse/sse_stream.dart';

/// One request captured by the in-process fixture.
class RecordedRequest {
  RecordedRequest(this.method, this.path, this.headers, this.body);

  final String method;
  final String path;
  final Map<String, String> headers;
  final String body;

  String? get clientHeader => headers['x-jhin-client'];
  String? get auth => headers['authorization'];
  String? get lastEventId => headers['last-event-id'];
}

/// Asserts the strict D-22 `X-Jhin-Client` format on one request.
void expectClientHeader(RecordedRequest request) {
  final header = request.clientHeader;
  expect(header, isNotNull, reason: '${request.method} ${request.path}');
  expect(
    header,
    matches(RegExp(r'^api=1; version=\d+\.\d+\.\d+; caps=[a-z0-9_,]+$')),
    reason: '${request.method} ${request.path}',
  );
  expect(header, buildXJhinClientHeader());
}

void main() {
  late HttpServer server;
  late List<RecordedRequest> recorded;
  late JhinTransport transport;

  /// Per-connection SSE script: (connection index, response) → done.
  Future<void> Function(int connection, HttpResponse response)? sseScript;

  setUp(() async {
    recorded = [];
    sseScript = null;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final headers = <String, String>{};
      request.headers.forEach((name, values) {
        headers[name.toLowerCase()] = values.join(',');
      });
      final body = await utf8.decoder.bind(request).join();
      recorded.add(RecordedRequest(
        request.method,
        request.uri.path,
        headers,
        body,
      ));
      final response = request.response;
      try {
        switch (request.uri.path) {
          case '/_jhin/health':
            response.headers.contentType = ContentType.json;
            response.write(jsonEncode({
              'status': 'ok',
              'kernel': '0.2.0',
              'api': 1,
              'plugins': [
                {'id': 'jhin.sessions', 'version': '0.2.0', 'name': 'Sessions'},
              ],
              'failed': [
                {'id': 'jhin.mcp', 'reason': 'requires jhin.agent >=0.2.0'},
              ],
            }));
          case '/json':
            response.headers.contentType = ContentType.json;
            response.write(jsonEncode({'ok': true, 'n': 1}));
          case '/echo':
            response.headers.contentType = ContentType.json;
            response.write(jsonEncode({'received': jsonDecode(body)}));
          case '/stream':
            final script = sseScript;
            if (script == null) {
              response.statusCode = HttpStatus.notFound;
            } else {
              await script(recorded.length - 1, response);
            }
          default:
            response.statusCode = HttpStatus.notFound;
            response.headers.contentType = ContentType.json;
            response.write(jsonEncode({'error': 'not_found'}));
        }
      } finally {
        await response.close();
      }
    });
    transport = JhinTransport(
      baseUrl: Uri.parse('http://127.0.0.1:${server.port}'),
      retryPolicy: const SseRetryPolicy(
        base: Duration(milliseconds: 10),
        jitterRatio: 0,
      ),
    );
  });

  tearDown(() async {
    transport.close();
    await server.close(force: true);
  });

  group('TransportTest', () {
    test('health parses the §6 payload', () async {
      final health = await transport.health('http://127.0.0.1:${server.port}');

      expect(health.status, 'ok');
      expect(health.kernel, '0.2.0');
      expect(health.api, 1);
      expect(health.plugins, hasLength(1));
      expect(health.plugins.single.id, 'jhin.sessions');
      expect(health.plugins.single.version, '0.2.0');
      expect(health.plugins.single.name, 'Sessions');
      expect(health.failed.single.id, 'jhin.mcp');
      expect(health.failed.single.reason, 'requires jhin.agent >=0.2.0');
      expect(recorded.single.path, '/_jhin/health');
      expect(recorded.single.auth, isNull);
      expectClientHeader(recorded.single);
    });

    test('health normalizes a trailing slash in the probed url', () async {
      await transport.health('http://127.0.0.1:${server.port}/');
      expect(recorded.single.path, '/_jhin/health');
    });

    test('getJson returns the decoded object', () async {
      final json = await transport.getJson('/json');
      expect(json, {'ok': true, 'n': 1});
      expect(recorded.single.method, 'GET');
      expectClientHeader(recorded.single);
    });

    test('postJson sends the body and returns the response', () async {
      transport.token = 'device-token';
      final json = await transport.postJson('/echo', {'text': 'hi'});

      expect(json, {
        'received': {'text': 'hi'}
      });
      expect(recorded.single.method, 'POST');
      expect(recorded.single.body, '{"text":"hi"}');
      expect(recorded.single.auth, 'Bearer device-token');
      expectClientHeader(recorded.single);
    });

    test('sse delivers JSON events and resumes via Last-Event-ID', () async {
      sseScript = (connection, response) async {
        response.headers.contentType = ContentType('text', 'event-stream');
        response.write(
          'id: ${connection + 1}\nevent: message\ndata: {"conn":$connection}\n\n',
        );
      };

      final events = await transport.sse('/stream').take(2).toList();

      expect(events, [
        {'conn': 0},
        {'conn': 1},
      ]);
      expect(recorded, hasLength(2));
      expect(recorded[0].lastEventId, isNull);
      expect(recorded[1].lastEventId, '1');
      expectClientHeader(recorded[0]);
      expectClientHeader(recorded[1]);
    });

    test('sse drops non-object payloads and keeps the rest', () async {
      sseScript = (connection, response) async {
        response.headers.contentType = ContentType('text', 'event-stream');
        response.write('data: {"keep":1}\n\n');
        response.write('data: [1,2]\n\n');
        response.write('data: not-json\n\n');
        response.write('data: {"keep":2}\n\n');
      };

      final events = await transport.sse('/stream').take(2).toList();
      expect(events, [
        {'keep': 1},
        {'keep': 2},
      ]);
    });

    test('every request carries X-Jhin-Client', () async {
      sseScript = (connection, response) async {
        response.headers.contentType = ContentType('text', 'event-stream');
        response.write('data: {"n":$connection}\n\n');
      };

      await transport.health('http://127.0.0.1:${server.port}');
      await transport.getJson('/json');
      await transport.postJson('/echo', {'a': 1});
      await transport.sse('/stream').take(1).toList();

      expect(recorded, hasLength(4));
      for (final request in recorded) {
        expectClientHeader(request);
      }
    });

    test('X-Jhin-Client version matches the pubspec semver', () {
      final pubspec = File('pubspec.yaml').readAsStringSync();
      final match = RegExp(r'^version:\s*(\d+\.\d+\.\d+)', multiLine: true)
          .firstMatch(pubspec);
      expect(match, isNotNull);
      expect(kJhinClientVersion, match!.group(1));
    });
  });
}