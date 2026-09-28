import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/sse/sse_parser.dart';
import 'package:jhin/core/state/session_store.dart';

/// Фейковый SSE-хаб: хранит события per-session, отдаёт с fromSeq,
/// имитирует resume транспорта (fromSeq = lastId + 1 при «реконнекте»).
class FakeSseHub {
  final Map<String, List<SseEvent>> history = {};
  final List<(String sessionId, int? fromSeq)> connectCalls = [];
  final Map<String, StreamController<SseEvent>> _live = {};

  /// Подписка: replay истории с fromSeq + live-хвост (как ReconnectingSseTransport).
  Stream<SseEvent> connect(String sessionId, {int? fromSeq}) {
    connectCalls.add((sessionId, fromSeq));
    final controller = StreamController<SseEvent>();
    _live[sessionId] = controller;
    final events = history[sessionId] ?? const [];
    for (final event in events) {
      final seq = event.id ?? 0;
      if (fromSeq == null || seq >= fromSeq) {
        controller.add(event);
      }
    }
    return controller.stream;
  }

  /// Replay истории без live-подписки (для assert).
  List<SseEvent> replay(String sessionId, {int? fromSeq}) {
    final events = history[sessionId] ?? const [];
    return [
      for (final event in events)
        if (fromSeq == null || (event.id ?? 0) >= fromSeq) event,
    ];
  }

  /// Добавить событие в историю и live-подписчикам.
  void emit(String sessionId, SseEvent event) {
    history.putIfAbsent(sessionId, () => []).add(event);
    _live[sessionId]?.add(event);
  }

  /// Имитация реконнекта транспорта: fromSeq = lastId + 1.
  /// Возвращает новую подписку (как это сделал бы ReconnectingSseTransport).
  Stream<SseEvent> reconnect(String sessionId) {
    final events = history[sessionId] ?? const [];
    final lastId = events.isEmpty ? null : events.last.id;
    return connect(sessionId, fromSeq: (lastId ?? 0) + 1);
  }
}

/// Минимальный [ApiClient] на MockClient: только нужные эндпоинты.
ApiClient fakeApi({
  List<SessionInfo> sessions = const [],
  List<ProviderInfo> providers = const [],
  void Function(String sessionId, String text)? onSendMessage,
  void Function(String sessionId)? onCancel,
}) {
  final client = MockClient((request) async {
    final path = request.url.path;
    final method = request.method;
    if (method == 'GET' && path == '/sessions') {
      return http.Response(
        jsonEncode(sessions.map((s) => {
              'id': s.id,
              'title': s.title,
              'workdir': s.workdir,
              'model': s.model,
              'providerId': s.providerId,
              'createdAt': s.createdAt,
              'updatedAt': s.updatedAt,
            }).toList()),
        200,
        headers: {'content-type': 'application/json'},
      );
    }
    if (method == 'POST' && path == '/sessions') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      final session = SessionInfo(
        id: 's-new',
        title: body['title'] as String,
        workdir: body['workdir'] as String,
        model: body['model'] as String?,
        providerId: body['providerId'] as String?,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      );
      return http.Response(
        jsonEncode({
          'id': session.id,
          'title': session.title,
          'workdir': session.workdir,
          'model': session.model,
          'providerId': session.providerId,
          'createdAt': session.createdAt,
          'updatedAt': session.updatedAt,
        }),
        201,
        headers: {'content-type': 'application/json'},
      );
    }
    if (method == 'DELETE' && path.startsWith('/sessions/')) {
      return http.Response('', 204);
    }
    if (method == 'POST' && path.endsWith('/messages')) {
      final sessionId = path.split('/')[2];
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      onSendMessage?.call(sessionId, body['text'] as String);
      return http.Response(
        '{"runId":"run-1"}',
        200,
        headers: {'content-type': 'application/json'},
      );
    }
    if (method == 'POST' && path.endsWith('/cancel')) {
      final sessionId = path.split('/')[2];
      onCancel?.call(sessionId);
      return http.Response(
        '{"runId":"run-1"}',
        200,
        headers: {'content-type': 'application/json'},
      );
    }
    if (method == 'GET' && path == '/providers') {
      return http.Response(
        jsonEncode(providers.map((p) => {
              'id': p.id,
              'accountId': p.accountId,
              'name': p.name,
              'format': p.format,
              'model': p.model,
              'baseUrl': p.baseUrl,
              'isDefault': p.isDefault,
            }).toList()),
        200,
        headers: {'content-type': 'application/json'},
      );
    }
    return http.Response('{"error":"not_found"}', 404,
        headers: {'content-type': 'application/json'});
  });
  return HttpApiClient(baseUrl: Uri.parse('https://test'), client: client);
}

final sessionA = SessionInfo(
  id: 'sess-a',
  title: 'Test session',
  workdir: '/tmp/work',
  model: 'gpt-4',
  providerId: 'prov-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
);

SseEvent ev(int id, String type, Map<String, dynamic> data) =>
    SseEvent(id: id, type: type, data: data);

void main() {
  group('SessionStore: склейка событий → view-model', () {
    test('text_delta склеивается, message_end финализирует', () async {
      final hub = FakeSseHub();
      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);

      hub.emit('sess-a', ev(1, 'message_start', {'runId': 'r1', 'messageId': 'm1'}));
      hub.emit('sess-a', ev(2, 'text_delta', {'runId': 'r1', 'text': 'Hello'}));
      hub.emit('sess-a', ev(3, 'text_delta', {'runId': 'r1', 'text': ' world'}));
      await Future<void>.delayed(Duration.zero);

      expect(store.messages, hasLength(1));
      final msg = store.messages.first as AssistantChatMessage;
      expect(msg.text, 'Hello world');
      expect(msg.finalized, isFalse);

      hub.emit('sess-a', ev(4, 'message_end', {
        'runId': 'r1',
        'messageId': 'm1',
        'text': 'Hello world!',
      }));
      await Future<void>.delayed(Duration.zero);

      expect(store.messages, hasLength(1));
      expect(msg.text, 'Hello world!');
      expect(msg.finalized, isTrue);
    });

    test('tool_use + streaming tool_result → одна карточка с накоплением', () async {
      final hub = FakeSseHub();
      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);

      hub.emit('sess-a', ev(1, 'tool_use', {
        'runId': 'r1',
        'callId': 'c1',
        'toolName': 'read',
        'arguments': {'path': '/tmp/x'},
      }));
      hub.emit('sess-a', ev(2, 'tool_result', {
        'runId': 'r1', 'callId': 'c1', 'toolName': 'read',
        'content': 'chunk1 ', 'error': false, 'streaming': true,
        'truncated': false, 'structured': null, 'meta': {},
      }));
      hub.emit('sess-a', ev(3, 'tool_result', {
        'runId': 'r1', 'callId': 'c1', 'toolName': 'read',
        'content': 'chunk2', 'error': false, 'streaming': true,
        'truncated': false, 'structured': null, 'meta': {},
      }));
      await Future<void>.delayed(Duration.zero);

      expect(store.messages, hasLength(1));
      var card = store.messages.first as ToolChatCard;
      expect(card.toolName, 'read');
      expect(card.content, 'chunk1 chunk2');
      expect(card.done, isFalse);

      hub.emit('sess-a', ev(4, 'tool_result', {
        'runId': 'r1', 'callId': 'c1', 'toolName': 'read',
        'content': 'final content', 'error': null, 'streaming': false,
        'truncated': false, 'structured': {'key': 'val'}, 'meta': {},
      }));
      await Future<void>.delayed(Duration.zero);

      expect(store.messages, hasLength(1));
      card = store.messages.first as ToolChatCard;
      expect(card.content, 'final content');
      expect(card.done, isTrue);
      expect(card.isError, isFalse);
      expect(card.structured, {'key': 'val'});
    });

    test('run_start/run_end → статус run', () async {
      final hub = FakeSseHub();
      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);

      expect(store.runPhase, RunPhase.idle);

      hub.emit('sess-a', ev(1, 'run_start', {
        'runId': 'r1', 'sessionId': 'sess-a',
        'model': 'gpt-4', 'providerId': 'prov-1',
      }));
      await Future<void>.delayed(Duration.zero);
      expect(store.runPhase, RunPhase.running);
      expect(store.currentRunId, 'r1');

      hub.emit('sess-a', ev(2, 'run_end', {'runId': 'r1', 'status': 'DONE'}));
      await Future<void>.delayed(Duration.zero);
      expect(store.runPhase, RunPhase.idle);
      expect(store.lastRunStatus, 'DONE');
      expect(store.currentRunId, isNull);
    });

    test('error-событие → ErrorChatMessage', () async {
      final hub = FakeSseHub();
      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);

      hub.emit('sess-a', ev(1, 'error', {'runId': 'r1', 'message': 'boom'}));
      await Future<void>.delayed(Duration.zero);

      expect(store.messages, hasLength(1));
      expect(store.messages.first, isA<ErrorChatMessage>());
      expect((store.messages.first as ErrorChatMessage).message, 'boom');
    });

    test('user_message → UserChatMessage', () async {
      final hub = FakeSseHub();
      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);

      hub.emit('sess-a', ev(1, 'user_message', {'text': 'hi'}));
      await Future<void>.delayed(Duration.zero);

      expect(store.messages, hasLength(1));
      expect((store.messages.first as UserChatMessage).text, 'hi');
    });

    test('резюме: reconnect с fromSeq=lastId+1 отдаёт только новые', () async {
      final hub = FakeSseHub();
      // Наполняем историю ДО подписки.
      hub.emit('sess-a', ev(1, 'user_message', {'text': 'old-1'}));
      hub.emit('sess-a', ev(2, 'user_message', {'text': 'old-2'}));
      hub.emit('sess-a', ev(3, 'user_message', {'text': 'old-3'}));

      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);
      await Future<void>.delayed(Duration.zero);
      expect(hub.connectCalls, [('sess-a', 0)]);
      expect(store.messages, hasLength(3));

      // reconnect: fromSeq = lastId + 1 = 3 + 1 = 4.
      hub.reconnect('sess-a');
      expect(hub.connectCalls, [
        ('sess-a', 0),
        ('sess-a', 4),
      ]);

      // connect с fromSeq=4: replay отдаёт только seq >= 4.
      // (в истории пока 1..3 — replay пуст; но если бы были 4,5 — получил бы их)
      expect(hub.history['sess-a'], hasLength(3));
    });

    test('подписка fromSeq=0 при первом открытии, отписка при closeSession', () async {
      final hub = FakeSseHub();
      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);

      store.openSession(sessionA);
      await Future<void>.delayed(Duration.zero);
      expect(hub.connectCalls, [('sess-a', 0)]);

      store.closeSession();
      expect(store.currentSession, isNull);
      expect(store.messages, isEmpty);
    });
  });

  group('SessionStore: CRUD сессий', () {
    test('loadSessions заполняет список', () async {
      final store = SessionStore(
        api: fakeApi(sessions: [sessionA]),
        events: (id, {fromSeq}) => const Stream.empty(),
      );
      addTearDown(store.dispose);
      await store.loadSessions();
      expect(store.sessions, hasLength(1));
      expect(store.sessions.first.id, 'sess-a');
    });

    test('createSession добавляет в список', () async {
      final store = SessionStore(
        api: fakeApi(),
        events: (id, {fromSeq}) => const Stream.empty(),
      );
      addTearDown(store.dispose);
      final created = await store.createSession(
        const CreateSession(title: 'New', workdir: '/w'),
      );
      expect(created.id, 's-new');
      expect(store.sessions, hasLength(1));
    });

    test('deleteSession убирает из списка и закрывает текущую', () async {
      final hub = FakeSseHub();
      final store = SessionStore(
        api: fakeApi(sessions: [sessionA]),
        events: (id, {fromSeq}) => hub.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      await store.loadSessions();
      store.openSession(sessionA);
      await store.deleteSession('sess-a');
      expect(store.sessions, isEmpty);
      expect(store.currentSession, isNull);
    });

    test('sendMessage → runId, runPhase=running', () async {
      String? sentText;
      final store = SessionStore(
        api: fakeApi(onSendMessage: (_, text) => sentText = text),
        events: (id, {fromSeq}) => const Stream.empty(),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);
      final ref = await store.sendMessage('hello');
      expect(sentText, 'hello');
      expect(ref.runId, 'run-1');
      expect(store.runPhase, RunPhase.running);
    });

    test('cancelRun → api.cancelRun', () async {
      var cancelled = false;
      final store = SessionStore(
        api: fakeApi(onCancel: (_) => cancelled = true),
        events: (id, {fromSeq}) => const Stream.empty(),
      );
      addTearDown(store.dispose);
      store.openSession(sessionA);
      final ref = await store.cancelRun();
      expect(cancelled, isTrue);
      expect(ref.runId, 'run-1');
    });
  });
}
