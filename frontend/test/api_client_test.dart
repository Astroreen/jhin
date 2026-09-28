import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/api_client.dart';

class RecordedRequest {
  RecordedRequest(this.method, this.uri, this.headers, this.body);

  final String method;
  final Uri uri;
  final HttpHeaders headers;
  final String body;

  String get path => uri.path;
  String? get auth => headers.value(HttpHeaders.authorizationHeader);
}

void main() {
  late HttpServer server;
  late List<RecordedRequest> recorded;
  late FutureOr<void> Function(RecordedRequest request, HttpResponse response)
      handler;

  late HttpApiClient client;

  setUp(() async {
    recorded = [];
    handler = (request, response) {
      response.statusCode = HttpStatus.notFound;
    };
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final body = await utf8.decoder.bind(request).join();
      final record = RecordedRequest(
          request.method, request.uri, request.headers, body);
      recorded.add(record);
      final response = request.response;
      response.headers.contentType = ContentType.json;
      await handler(record, response);
      await response.close();
    });
    client = HttpApiClient(
      baseUrl: Uri.parse('http://127.0.0.1:${server.port}'),
      token: 'device-token-1',
    );
  });

  tearDown(() async {
    client.close();
    await server.close(force: true);
  });

  void reply(Object? json, {int status = 200}) {
    handler = (request, response) {
      response.statusCode = status;
      if (json != null) {
        response.write(jsonEncode(json));
      }
    };
  }

  group('anon-эндпоинты (без Authorization)', () {
    test('health() → {"status":"UP"}', () async {
      reply({'status': 'UP'});
      final health = await client.health();
      expect(health.status, 'UP');
      expect(recorded.single.path, '/health');
      expect(recorded.single.auth, isNull);
    });

    test('enroll() → deviceToken/accountId/accountName, тело code+deviceName',
        () async {
      reply({
        'deviceToken': 'fresh-token',
        'accountId': 'acc-1',
        'accountName': 'alice',
      }, status: 200);
      final result = await client.enroll(code: 'enroll-code', deviceName: 'laptop');
      expect(result.deviceToken, 'fresh-token');
      expect(result.accountId, 'acc-1');
      expect(result.accountName, 'alice');
      expect(recorded.single.path, '/enroll');
      expect(recorded.single.auth, isNull);
      expect(jsonDecode(recorded.single.body), {'code': 'enroll-code', 'deviceName': 'laptop'});
    });
  });

  group('sessions', () {
    Map<String, Object?> sessionJson(String id, String title) => {
          'id': id,
          'title': title,
          'workdir': '/work/$id',
          'model': 'gpt-x',
          'providerId': 'prov-1',
          'createdAt': '2026-09-28T10:00:00Z',
          'updatedAt': '2026-09-28T10:05:00Z',
        };

    test('listSessions() → массив, Authorization реально шлётся', () async {
      reply([
        sessionJson('s1', 'one'),
        sessionJson('s2', 'two'),
      ]);
      final sessions = await client.listSessions();
      expect(sessions, hasLength(2));
      expect(sessions[0].id, 's1');
      expect(sessions[0].title, 'one');
      expect(sessions[0].workdir, '/work/s1');
      expect(sessions[0].model, 'gpt-x');
      expect(sessions[0].providerId, 'prov-1');
      expect(sessions[0].createdAt, '2026-09-28T10:00:00Z');
      expect(sessions[1].id, 's2');
      expect(recorded.single.auth, 'Bearer device-token-1');
      expect(recorded.single.method, 'GET');
      expect(recorded.single.path, '/sessions');
    });

    test('listSessions() парсит null model/providerId', () async {
      reply([
        {
          ...sessionJson('s1', 'one'),
          'model': null,
          'providerId': null,
        }
      ]);
      final sessions = await client.listSessions();
      expect(sessions.single.model, isNull);
      expect(sessions.single.providerId, isNull);
    });

    test('createSession() → 201, тело title/workdir + опциональные', () async {
      reply(sessionJson('s1', 'new'), status: 201);
      final created = await client.createSession(const CreateSession(
        title: 'new',
        workdir: '/work',
      ));
      expect(created.id, 's1');
      expect(recorded.single.method, 'POST');
      expect(jsonDecode(recorded.single.body),
          {'title': 'new', 'workdir': '/work'});
    });

    test('createSession() шлёт model/providerId когда заданы', () async {
      reply(sessionJson('s1', 'new'), status: 201);
      await client.createSession(const CreateSession(
        title: 'new',
        workdir: '/work',
        model: 'gpt-x',
        providerId: 'prov-1',
      ));
      expect(jsonDecode(recorded.single.body), {
        'title': 'new',
        'workdir': '/work',
        'model': 'gpt-x',
        'providerId': 'prov-1',
      });
    });

    test('getSession() → 200', () async {
      reply(sessionJson('s1', 'one'));
      final session = await client.getSession('s1');
      expect(session.title, 'one');
      expect(recorded.single.path, '/sessions/s1');
    });

    test('patchSession() шлёт только явные поля', () async {
      reply(sessionJson('s1', 'renamed'));
      final updated = await client.patchSession(
        's1',
        const PatchSession(title: 'renamed'),
      );
      expect(updated.title, 'renamed');
      expect(recorded.single.method, 'PATCH');
      expect(jsonDecode(recorded.single.body), {'title': 'renamed'});
    });

    test('deleteSession() → 204 без тела', () async {
      reply(null, status: 204);
      await client.deleteSession('s1');
      expect(recorded.single.method, 'DELETE');
      expect(recorded.single.path, '/sessions/s1');
    });

    test('sendMessage() → {"runId":"..."}', () async {
      reply({'runId': 'run-1'});
      final run = await client.sendMessage('s1', 'hello');
      expect(run.runId, 'run-1');
      expect(recorded.single.path, '/sessions/s1/messages');
      expect(jsonDecode(recorded.single.body), {'text': 'hello'});
    });

    test('cancelRun() → {"runId":null} при отсутствии активного run', () async {
      reply({'runId': null});
      final run = await client.cancelRun('s1');
      expect(run.runId, isNull);
      expect(recorded.single.path, '/sessions/s1/cancel');
    });

    test('sendUiAction() → {"seq":7}, тело action+payload', () async {
      reply({'seq': 7});
      final ack = await client.sendUiAction(
        's1',
        const UiAction(action: 'pick', payload: {'choice': 2}),
      );
      expect(ack.seq, 7);
      expect(recorded.single.path, '/sessions/s1/ui-action');
      expect(jsonDecode(recorded.single.body), {
        'action': 'pick',
        'payload': {'choice': 2},
      });
    });
  });

  group('providers', () {
    Map<String, Object?> providerJson(String id) => {
          'id': id,
          'accountId': 'acc-1',
          'name': 'openai',
          'format': 'openai',
          'model': 'gpt-x',
          'baseUrl': 'https://api.example.com/v1',
          'isDefault': true,
        };

    test('listProviders() парсит isDefault/baseUrl', () async {
      reply([providerJson('p1')]);
      final providers = await client.listProviders();
      final provider = providers.single;
      expect(provider.id, 'p1');
      expect(provider.accountId, 'acc-1');
      expect(provider.name, 'openai');
      expect(provider.format, 'openai');
      expect(provider.model, 'gpt-x');
      expect(provider.baseUrl, 'https://api.example.com/v1');
      expect(provider.isDefault, isTrue);
    });

    test('createProvider() → 201, тело с apiKey и isDefault', () async {
      reply(providerJson('p1'), status: 201);
      final created = await client.createProvider(const CreateProvider(
        name: 'openai',
        format: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-x',
        baseUrl: 'https://api.example.com/v1',
        isDefault: true,
      ));
      expect(created.id, 'p1');
      expect(jsonDecode(recorded.single.body), {
        'name': 'openai',
        'format': 'openai',
        'apiKey': 'sk-test',
        'model': 'gpt-x',
        'baseUrl': 'https://api.example.com/v1',
        'isDefault': true,
      });
    });

    test('getProvider() → 200, deleteProvider() → 204', () async {
      reply(providerJson('p1'));
      await client.getProvider('p1');
      expect(recorded[0].path, '/providers/p1');
      reply(null, status: 204);
      await client.deleteProvider('p1');
      expect(recorded[1].method, 'DELETE');
      expect(recorded[1].path, '/providers/p1');
    });
  });

  group('admin/manifest', () {
    test('reload() → 202 {"status":"restarting"}', () async {
      reply({'status': 'restarting'}, status: 202);
      final ack = await client.reload();
      expect(ack.status, 'restarting');
      expect(recorded.single.method, 'POST');
      expect(recorded.single.path, '/admin/reload');
    });

    test('getUiManifest() → 200 map', () async {
      reply({'version': 1, 'primitives': ['text']});
      final manifest = await client.getUiManifest();
      expect(manifest, {'version': 1, 'primitives': ['text']});
    });

    test('getUiManifest() → 404 переживается как null', () async {
      reply({'error': 'not_found'}, status: 404);
      expect(await client.getUiManifest(), isNull);
    });
  });

  group('ошибки → ApiClientException', () {
    test('400 bad_request', () async {
      reply({'error': 'bad_request'}, status: 400);
      await expectLater(
        client.createSession(const CreateSession(title: '', workdir: '')),
        throwsA(isA<ApiClientException>()
            .having((e) => e.statusCode, 'statusCode', 400)
            .having((e) => e.error, 'error', 'bad_request')),
      );
    });

    test('404 not_found', () async {
      reply({'error': 'not_found'}, status: 404);
      await expectLater(
        client.getSession('missing'),
        throwsA(isA<ApiClientException>()
            .having((e) => e.statusCode, 'statusCode', 404)
            .having((e) => e.error, 'error', 'not_found')),
      );
    });

    test('429 rate_limited', () async {
      reply({'error': 'rate_limited'}, status: 429);
      await expectLater(
        client.enroll(code: 'x', deviceName: 'y'),
        throwsA(isA<ApiClientException>()
            .having((e) => e.statusCode, 'statusCode', 429)
            .having((e) => e.error, 'error', 'rate_limited')),
      );
    });

    test('503 restart manually (reload, dev-режим)', () async {
      reply({'error': 'restart manually'}, status: 503);
      await expectLater(
        client.reload(),
        throwsA(isA<ApiClientException>()
            .having((e) => e.statusCode, 'statusCode', 503)
            .having((e) => e.error, 'error', 'restart manually')),
      );
    });

    test('не-JSON тело ошибки → error=null, статус сохраняется', () async {
      handler = (request, response) {
        response.statusCode = 500;
        response.write('boom');
      };
      await expectLater(
        client.listSessions(),
        throwsA(isA<ApiClientException>()
            .having((e) => e.statusCode, 'statusCode', 500)
            .having((e) => e.error, 'error', isNull)),
      );
    });
  });
}
