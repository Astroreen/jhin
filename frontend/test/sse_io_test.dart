import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/sse/sse_transport.dart';

class SseProbe {
  SseProbe(this.fromSeq, this.auth, this.accept);

  final String? fromSeq;
  final String? auth;
  final String? accept;
}

void main() {
  late HttpServer server;
  late List<SseProbe> probes;
  late FutureOr<void> Function(HttpRequest request, int index) handler;

  late SseTransport transport;

  setUp(() async {
    probes = [];
    handler = (request, index) {};
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final index = probes.length;
      probes.add(SseProbe(
        request.uri.queryParameters['fromSeq'],
        request.headers.value(HttpHeaders.authorizationHeader),
        request.headers.value(HttpHeaders.acceptHeader),
      ));
      await handler(request, index);
    });
  });

  tearDown(() async {
    transport.close();
    await server.close(force: true);
  });

  String eventsUrl() => 'http://127.0.0.1:${server.port}/sessions/s1/events';

  SseTransport makeTransport({
    SseStatusCallback? onStatus,
    SseRetryPolicy retryPolicy = const SseRetryPolicy(
      base: Duration(milliseconds: 20),
      max: Duration(milliseconds: 50),
    ),
  }) {
    transport = createSseTransport(
      onStatus: onStatus,
      retryPolicy: retryPolicy,
    );
    return transport;
  }

  test('события + keepalive-комментарий: порядок/содержимое, Bearer шлётся',
      () async {
    handler = (request, index) async {
      final response = request.response..bufferOutput = false;
      response.statusCode = HttpStatus.ok;
      response.headers.contentType = ContentType('text', 'event-stream');
      response.write('id: 1\nevent: user_message\ndata: {"text":"one"}\n\n');
      response.write(': keepalive\n\n');
      response.write('id: 2\nevent: text_delta\ndata: {"runId":"r","text":"hi"}\n\n');
      await response.flush();
      await response.close();
    };
    final statuses = <SseTransportStatus>[];
    final t = makeTransport(
      // первый обрыв не должен реконнектиться внутри теста
      retryPolicy: const SseRetryPolicy(base: Duration(hours: 1)),
      onStatus: statuses.add,
    );

    final events = await t
        .connect(eventsUrl(), token: 'device-token-1')
        .take(2)
        .toList();

    expect(events, hasLength(2));
    expect(events[0].id, 1);
    expect(events[0].type, 'user_message');
    expect(events[0].data, {'text': 'one'});
    expect(events[1].id, 2);
    expect(events[1].type, 'text_delta');
    expect(events[1].data, {'runId': 'r', 'text': 'hi'});

    expect(probes.single.auth, 'Bearer device-token-1');
    expect(probes.single.accept, 'text/event-stream');
    expect(probes.single.fromSeq, isNull);
    expect(t.lastEventId, 2);
    expect(statuses, contains(SseTransportStatus.connecting));
    expect(statuses, contains(SseTransportStatus.connected));
  });

  test('auto-reconnect: fromSeq = lastId + 1 после обрыва (resume без дыр)',
      () async {
    handler = (request, index) async {
      final response = request.response..bufferOutput = false;
      response.statusCode = HttpStatus.ok;
      response.headers.contentType = ContentType('text', 'event-stream');
      if (index == 0) {
        response.write('id: 1\nevent: user_message\ndata: {"text":"one"}\n\n');
        response.write('id: 2\nevent: text_delta\ndata: {"text":"two"}\n\n');
        await response.flush();
        await response.close(); // cap-обрыв
      } else {
        response.write('id: 3\nevent: run_end\ndata: {"status":"DONE"}\n\n');
        await response.flush();
        // держим соединение открытым — реконнектов больше не будет
      }
    };
    final t = makeTransport();

    final events = await t.connect(eventsUrl(), token: 'tok').take(3).toList();

    expect(events.map((e) => e.id), [1, 2, 3]);
    expect(events.map((e) => e.type),
        ['user_message', 'text_delta', 'run_end']);
    // первый connect — без fromSeq; реконнект — с fromSeq = 2 + 1
    expect(probes, hasLength(2));
    expect(probes[0].fromSeq, isNull);
    expect(probes[1].fromSeq, '3');
  });

  test('fromSeq передаётся в query первого connect', () async {
    handler = (request, index) async {
      final response = request.response..bufferOutput = false;
      response.statusCode = HttpStatus.ok;
      response.headers.contentType = ContentType('text', 'event-stream');
      response.write('id: 5\nevent: ui\ndata: {"a":1}\n\n');
      await response.flush();
      await response.close();
    };
    final t = makeTransport(
      retryPolicy: const SseRetryPolicy(base: Duration(hours: 1)),
    );

    final events =
        await t.connect(eventsUrl(), fromSeq: 5).take(1).toList();

    expect(events.single.id, 5);
    expect(probes.single.fromSeq, '5');
  });

  test('4xx фатален: ошибка в потоке и done', () async {
    handler = (request, index) async {
      final response = request.response..bufferOutput = false;
      response.statusCode = HttpStatus.notFound;
      response.headers.contentType = ContentType.json;
      response.write('{"error":"not_found"}');
      await response.close();
    };
    final t = makeTransport();

    final events = <SseEvent>[];
    final errors = <Object>[];
    final done = Completer<void>();
    final sub = t.connect(eventsUrl()).listen(
      events.add,
      onError: errors.add,
      onDone: done.complete,
    );
    await done.future.timeout(const Duration(seconds: 2));
    await sub.cancel();

    expect(events, isEmpty);
    expect(errors, hasLength(1));
    expect(
      errors.single,
      isA<ApiClientException>().having((e) => e.statusCode, 'statusCode', 404),
    );
  });

  test('close() закрывает поток и останавливает ретраи', () async {
    handler = (request, index) async {
      final response = request.response..bufferOutput = false;
      response.statusCode = HttpStatus.ok;
      response.headers.contentType = ContentType('text', 'event-stream');
      response.write('id: 1\nevent: user_message\ndata: {"text":"one"}\n\n');
      await response.flush();
    };
    final t = makeTransport();

    final received = <SseEvent>[];
    final done = Completer<void>();
    final sub = t.connect(eventsUrl()).listen(received.add, onDone: done.complete);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    t.close();
    await done.future.timeout(const Duration(seconds: 2));
    await sub.cancel();

    expect(received, hasLength(1));
    expect(probes, hasLength(1));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(probes, hasLength(1), reason: 'ретраи после close не должны идти');
  });

  test('статус reconnecting при обрыве и повторном подключении', () async {
    handler = (request, index) async {
      final response = request.response..bufferOutput = false;
      response.statusCode = HttpStatus.ok;
      response.headers.contentType = ContentType('text', 'event-stream');
      response.write('id: $index\nevent: user_message\ndata: {"n":$index}\n\n');
      await response.flush();
      await response.close();
    };
    final statuses = <SseTransportStatus>[];
    final t = makeTransport(
      onStatus: statuses.add,
      retryPolicy: const SseRetryPolicy(
        base: Duration(milliseconds: 10),
        max: Duration(milliseconds: 20),
      ),
    );

    final events = await t.connect(eventsUrl()).take(2).toList();

    expect(events.map((e) => e.id), [0, 1]);
    expect(statuses, containsAll([
      SseTransportStatus.connecting,
      SseTransportStatus.connected,
      SseTransportStatus.reconnecting,
    ]));
  });
}
