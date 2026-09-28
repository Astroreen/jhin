import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/state/session_store.dart';
import 'package:jhin/screens/chat_screen.dart';
import 'package:jhin/screens/sessions_screen.dart';
import 'package:provider/provider.dart';

/// Мок-API: маршрутизация по path+method, запросы пишутся в [log].
ApiClient mockApi({
  List<SessionInfo> sessions = const [],
  List<ProviderInfo> providers = const [],
  List<(String method, String path, String body)>? log,
}) {
  final client = MockClient((request) async {
    log?.add((request.method, request.url.path, request.body));
    final path = request.url.path;
    final method = request.method;
    final headers = {'content-type': 'application/json'};
    if (method == 'GET' && path == '/sessions') {
      return http.Response(jsonEncode(_sessionsJson(sessions)), 200,
          headers: headers);
    }
    if (method == 'POST' && path == '/sessions') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      return http.Response(
        jsonEncode({
          'id': 's-new',
          'title': body['title'],
          'workdir': body['workdir'],
          'model': body['model'],
          'providerId': body['providerId'],
          'createdAt': '2026-01-01T00:00:00Z',
          'updatedAt': '2026-01-01T00:00:00Z',
        }),
        201,
        headers: headers,
      );
    }
    if (method == 'DELETE' && path.startsWith('/sessions/')) {
      return http.Response('', 204);
    }
    if (method == 'GET' && path == '/providers') {
      return http.Response(
        jsonEncode([
          for (final p in providers)
            {
              'id': p.id,
              'accountId': p.accountId,
              'name': p.name,
              'format': p.format,
              'model': p.model,
              'baseUrl': p.baseUrl,
              'isDefault': p.isDefault,
            },
        ]),
        200,
        headers: headers,
      );
    }
    return http.Response('{"error":"not_found"}', 404, headers: headers);
  });
  return HttpApiClient(baseUrl: Uri.parse('https://test'), client: client);
}

List<Map<String, dynamic>> _sessionsJson(List<SessionInfo> sessions) => [
      for (final s in sessions)
        {
          'id': s.id,
          'title': s.title,
          'workdir': s.workdir,
          'model': s.model,
          'providerId': s.providerId,
          'createdAt': s.createdAt,
          'updatedAt': s.updatedAt,
        },
    ];

final testSession = SessionInfo(
  id: 'sess-1',
  title: 'My session',
  workdir: '/home/project',
  model: 'gpt-4',
  providerId: 'prov-1',
  createdAt: '2026-09-28T10:00:00Z',
  updatedAt: '2026-09-28T12:00:00Z',
);

final testProvider = ProviderInfo(
  id: 'prov-1',
  accountId: 'acc-1',
  name: 'OpenAI',
  format: 'openai',
  model: 'gpt-4',
  baseUrl: null,
  isDefault: true,
);

Widget wrap({
  required SessionStore store,
  required Widget child,
}) {
  return ChangeNotifierProvider<SessionStore>.value(
    value: store,
    child: MaterialApp(home: child),
  );
}

SessionStore makeStore(ApiClient api) => SessionStore(
      api: api,
      events: (id, {fromSeq}) => const Stream.empty(),
    );

void main() {
  group('SessionsScreen', () {
    testWidgets('рендер списка сессий', (tester) async {
      final store = makeStore(mockApi(sessions: [testSession]));
      addTearDown(store.dispose);
      await tester.pumpWidget(
        wrap(
          store: store,
          child: SessionsScreen(accountName: 'alice', onSignOut: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('My session'), findsOneWidget);
      expect(find.text('Новая сессия'), findsOneWidget);
    });

    testWidgets('пустое состояние', (tester) async {
      final store = makeStore(mockApi());
      addTearDown(store.dispose);
      await tester.pumpWidget(
        wrap(
          store: store,
          child: SessionsScreen(accountName: 'alice', onSignOut: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Нет сессий'), findsOneWidget);
    });

    testWidgets('FAB → диалог создания с dropdown провайдеров', (tester) async {
      final log = <(String, String, String)>[];
      final store = makeStore(mockApi(providers: [testProvider], log: log));
      addTearDown(store.dispose);
      await tester.pumpWidget(
        wrap(
          store: store,
          child: SessionsScreen(accountName: 'alice', onSignOut: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('btn-new-session')));
      await tester.pumpAndSettle();

      expect(find.text('Новая сессия'), findsWidgets); // диалог + FAB
      expect(find.byKey(const Key('field-session-title')), findsOneWidget);
      expect(find.byKey(const Key('field-session-workdir')), findsOneWidget);
      expect(find.byKey(const Key('dropdown-model')), findsOneWidget);
    });

    testWidgets('создание: POST /sessions с model+providerId из dropdown', (
      tester,
    ) async {
      final log = <(String, String, String)>[];
      final store = makeStore(mockApi(providers: [testProvider], log: log));
      addTearDown(store.dispose);
      await tester.pumpWidget(
        wrap(
          store: store,
          child: SessionsScreen(accountName: 'alice', onSignOut: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('btn-new-session')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('field-session-title')),
        'New task',
      );
      await tester.enterText(
        find.byKey(const Key('field-session-workdir')),
        '/work/dir',
      );
      await tester.tap(find.byKey(const Key('btn-create-session')));
      await tester.pumpAndSettle();

      final createCalls = log.where((e) => e.$1 == 'POST' && e.$2 == '/sessions');
      expect(createCalls, hasLength(1));
      final body = jsonDecode(createCalls.single.$3) as Map<String, dynamic>;
      expect(body['title'], 'New task');
      expect(body['workdir'], '/work/dir');
      expect(body['model'], 'gpt-4');
      expect(body['providerId'], 'prov-1');
    });

    testWidgets('пустой список провайдеров → заглушка про Settings', (
      tester,
    ) async {
      final store = makeStore(mockApi());
      addTearDown(store.dispose);
      await tester.pumpWidget(
        wrap(
          store: store,
          child: SessionsScreen(accountName: 'alice', onSignOut: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('btn-new-session')));
      await tester.pumpAndSettle();

      expect(find.textContaining('Нет провайдеров'), findsOneWidget);
      expect(find.byKey(const Key('dropdown-model')), findsNothing);
    });

    testWidgets('удаление: dismiss → confirm → DELETE', (tester) async {
      final log = <(String, String, String)>[];
      final store = makeStore(mockApi(sessions: [testSession], log: log));
      addTearDown(store.dispose);
      await tester.pumpWidget(
        wrap(
          store: store,
          child: SessionsScreen(accountName: 'alice', onSignOut: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      await tester.fling(find.text('My session'), const Offset(-300, 0), 1000);
      await tester.pumpAndSettle();

      expect(find.text('Удалить сессию?'), findsOneWidget);
      await tester.tap(find.byKey(const Key('btn-confirm-delete')));
      await tester.pumpAndSettle();

      final deletes = log.where((e) => e.$1 == 'DELETE');
      expect(deletes, hasLength(1));
      expect(deletes.single.$2, '/sessions/sess-1');
    });

    testWidgets('tap → ChatScreen', (tester) async {
      final store = makeStore(mockApi(sessions: [testSession]));
      addTearDown(store.dispose);
      await tester.pumpWidget(
        wrap(
          store: store,
          child: SessionsScreen(accountName: 'alice', onSignOut: () async {}),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('session-sess-1')));
      await tester.pumpAndSettle();

      expect(find.byType(ChatScreen), findsOneWidget);
    });
  });
}
