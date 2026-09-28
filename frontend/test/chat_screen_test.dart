import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/sse/sse_parser.dart';
import 'package:jhin/core/state/session_store.dart';
import 'package:jhin/screens/chat_screen.dart';
import 'package:provider/provider.dart';

/// Мок-API: sendMessage/cancelRun логируются.
ApiClient mockApi({
  List<(String method, String path, String body)>? log,
}) {
  final client = MockClient((request) async {
    log?.add((request.method, request.url.path, request.body));
    final path = request.url.path;
    final headers = {'content-type': 'application/json'};
    if (request.method == 'POST' && path.endsWith('/messages')) {
      return http.Response('{"runId":"run-42"}', 200, headers: headers);
    }
    if (request.method == 'POST' && path.endsWith('/cancel')) {
      return http.Response('{"runId":"run-42"}', 200, headers: headers);
    }
    return http.Response('{"error":"not_found"}', 404, headers: headers);
  });
  return HttpApiClient(baseUrl: Uri.parse('https://test'), client: client);
}

final testSession = SessionInfo(
  id: 'sess-1',
  title: 'Chat session',
  workdir: '/work',
  model: 'gpt-4',
  providerId: 'prov-1',
  createdAt: '2026-09-28T10:00:00Z',
  updatedAt: '2026-09-28T12:00:00Z',
);

/// SSE-хаб: контроллер для ручной подачи событий.
class TestSseSource {
  StreamController<SseEvent>? controller;
  final List<int?> fromSeqCalls = [];

  Stream<SseEvent> connect(String sessionId, {int? fromSeq}) {
    fromSeqCalls.add(fromSeq);
    controller = StreamController<SseEvent>();
    return controller!.stream;
  }

  void emit(SseEvent event) => controller?.add(event);

  void dispose() => controller?.close();
}

Widget wrap({required SessionStore store, required Widget child}) {
  return ChangeNotifierProvider<SessionStore>.value(
    value: store,
    child: MaterialApp(home: child),
  );
}

SseEvent ev(int id, String type, Map<String, dynamic> data) =>
    SseEvent(id: id, type: type, data: data);

void main() {
  group('ChatScreen', () {
    testWidgets('лента рендерит user / assistant / tool-карточку', (
      tester,
    ) async {
      final sse = TestSseSource();
      addTearDown(sse.dispose);
      final store = SessionStore(
        api: mockApi(),
        events: (id, {fromSeq}) => sse.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(testSession);

      await tester.pumpWidget(
        wrap(store: store, child: ChatScreen(session: testSession)),
      );
      await tester.pump();

      sse.emit(ev(1, 'user_message', {'text': 'Привет'}));
      sse.emit(ev(2, 'message_start', {'runId': 'r1', 'messageId': 'm1'}));
      sse.emit(ev(3, 'text_delta', {'runId': 'r1', 'text': '**Ответ**'}));
      sse.emit(ev(4, 'message_end', {
        'runId': 'r1', 'messageId': 'm1', 'text': '**Ответ**',
      }));
      sse.emit(ev(5, 'tool_use', {
        'runId': 'r1', 'callId': 'c1', 'toolName': 'read',
        'arguments': {'path': '/tmp/x'},
      }));
      sse.emit(ev(6, 'tool_result', {
        'runId': 'r1', 'callId': 'c1', 'toolName': 'read',
        'content': 'file content here', 'error': null, 'streaming': false,
        'truncated': false, 'structured': null, 'meta': {},
      }));
      await tester.pump();
      await tester.pump();

      expect(find.text('Привет'), findsOneWidget);
      // MarkdownBody рендерит **Ответ** как жирный текст.
      expect(find.textContaining('Ответ'), findsOneWidget);
      // Tool-карточка свёрнутая: заголовок с toolName.
      expect(find.textContaining('read'), findsOneWidget);
      expect(find.textContaining('done'), findsOneWidget);
    });

    testWidgets('send вызывает POST messages и очищает input', (tester) async {
      final log = <(String, String, String)>[];
      final sse = TestSseSource();
      addTearDown(sse.dispose);
      final store = SessionStore(
        api: mockApi(log: log),
        events: (id, {fromSeq}) => sse.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(testSession);

      await tester.pumpWidget(
        wrap(store: store, child: ChatScreen(session: testSession)),
      );
      await tester.pump();
      await tester.pump();

      await tester.enterText(
        find.byKey(const Key('field-message-input')),
        'hello world',
      );
      await tester.tap(find.byKey(const Key('btn-send')));
      await tester.pump();

      final sends = log.where((e) => e.$2.endsWith('/messages'));
      expect(sends, hasLength(1));
      final body = jsonDecode(sends.single.$3) as Map<String, dynamic>;
      expect(body['text'], 'hello world');

      final input = tester.widget<TextField>(
        find.byKey(const Key('field-message-input')),
      );
      expect(input.controller!.text, isEmpty);
    });

    testWidgets('Cancel виден только при активном run и зовёт cancel', (
      tester,
    ) async {
      final log = <(String, String, String)>[];
      final sse = TestSseSource();
      addTearDown(sse.dispose);
      final store = SessionStore(
        api: mockApi(log: log),
        events: (id, {fromSeq}) => sse.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(testSession);

      await tester.pumpWidget(
        wrap(store: store, child: ChatScreen(session: testSession)),
      );
      await tester.pump();
      await tester.pump();

      // До run: Cancel не виден.
      expect(find.byKey(const Key('btn-cancel-run')), findsNothing);

      // Run стартовал.
      sse.emit(ev(1, 'run_start', {
        'runId': 'run-42', 'sessionId': 'sess-1',
        'model': 'gpt-4', 'providerId': 'prov-1',
      }));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('btn-cancel-run')), findsOneWidget);

      await tester.tap(find.byKey(const Key('btn-cancel-run')));
      await tester.pump();
      final cancels = log.where((e) => e.$2.endsWith('/cancel'));
      expect(cancels, hasLength(1));

      // Run завершился — Cancel скрыт.
      sse.emit(ev(2, 'run_end', {'runId': 'run-42', 'status': 'CANCELLED'}));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('btn-cancel-run')), findsNothing);
    });

    testWidgets('tool-карточка свёрнутая: раскрытие показывает arguments', (
      tester,
    ) async {
      final sse = TestSseSource();
      addTearDown(sse.dispose);
      final store = SessionStore(
        api: mockApi(),
        events: (id, {fromSeq}) => sse.connect(id, fromSeq: fromSeq),
      );
      addTearDown(store.dispose);
      store.openSession(testSession);

      await tester.pumpWidget(
        wrap(store: store, child: ChatScreen(session: testSession)),
      );
      await tester.pump();

      sse.emit(ev(1, 'tool_use', {
        'runId': 'r1', 'callId': 'c1', 'toolName': 'write',
        'arguments': {'path': '/tmp/f', 'content': 'data'},
      }));
      await tester.pump();
      await tester.pump();

      // Свёрнута: arguments не виден.
      expect(find.textContaining('arguments:'), findsNothing);

      // Раскрываем.
      await tester.tap(find.text('write — running'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining('arguments:'), findsOneWidget);
    });
  });
}
