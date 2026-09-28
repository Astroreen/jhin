import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:jhin/core/api/api_client.dart';
import 'package:jhin/core/state/manifest_store.dart';

/// Форма `GET /ui/manifest` (см. UiManifestController на backend'е).
Map<String, dynamic> manifestJson({List<Map<String, dynamic>>? tools}) => {
      'tools': tools ??
          [
            {'name': 'bash', 'description': 'Runs a shell command'},
            {'name': 'read', 'description': 'Reads a file'},
          ],
      'primitives': [
        'container',
        'card',
        'text',
        'button',
        'dropdown',
        'list',
        'drawer',
        'form',
        'chart_line',
        'chart_bar',
        'chart_pie',
        'figure',
        'table',
        'markdown',
      ],
      'version': '0.1.0',
    };

/// HttpApiClient поверх MockClient: каждый запрос дёргает [handler].
ApiClient fakeApi(Future<http.Response> Function(http.Request request) handler) {
  final api = HttpApiClient(
    baseUrl: Uri.parse('https://test'),
    client: MockClient(handler),
  );
  addTearDown(api.close);
  return api;
}

void main() {
  test('refresh() парсит форму manifest', () async {
    final api = fakeApi((request) async {
      expect(request.url.path, '/ui/manifest');
      return http.Response(jsonEncode(manifestJson()), 200);
    });
    final store = ManifestStore(api: api);

    await store.refresh();

    expect(store.isLoaded, isTrue);
    final manifest = store.manifest!;
    expect(manifest.version, '0.1.0');
    expect(manifest.tools.map((tool) => tool.name), ['bash', 'read']);
    expect(manifest.tools.first.description, 'Runs a shell command');
    expect(manifest.primitives, [
      'container',
      'card',
      'text',
      'button',
      'dropdown',
      'list',
      'drawer',
      'form',
      'chart_line',
      'chart_bar',
      'chart_pie',
      'figure',
      'table',
      'markdown',
    ]);
  });

  test('null-ответ (404/401) → manifest=null, без исключений', () async {
    final api = fakeApi(
      (request) async => http.Response('{"error":"unauthorized"}', 401),
    );
    final store = ManifestStore(api: api);

    await store.refresh();

    expect(store.manifest, isNull);
    expect(store.isLoaded, isFalse);
  });

  test('ошибка сервера не вылетает: manifest=null', () async {
    final api = fakeApi(
      (request) async => http.Response('boom', 500),
    );
    final store = ManifestStore(api: api);

    await store.refresh();

    expect(store.manifest, isNull);
    expect(store.isLoaded, isFalse);
  });

  test('повторный refresh обновляет (после добавления плагина)', () async {
    final tools = <Map<String, dynamic>>[
      {'name': 'bash', 'description': 'Runs a shell command'},
      {'name': 'read', 'description': 'Reads a file'},
    ];
    final api = fakeApi(
      (request) async => http.Response(jsonEncode(manifestJson(tools: tools)), 200),
    );
    final store = ManifestStore(api: api);

    await store.refresh();
    expect(store.manifest!.tools.map((tool) => tool.name), ['bash', 'read']);

    // Плагин добавил тул → backend отдаёт его в манифесте.
    tools.add({'name': 't32-plugin-tool', 'description': 'fake plugin tool'});
    await store.refresh();
    expect(
      store.manifest!.tools.map((tool) => tool.name),
      contains('t32-plugin-tool'),
    );
  });

  test('updateFrom: кладёт JSON без запроса; null очищает', () async {
    final api = fakeApi((request) async => http.Response('unused', 500));
    final store = ManifestStore(api: api);

    store.updateFrom(manifestJson());
    expect(store.isLoaded, isTrue);
    expect(store.manifest!.version, '0.1.0');

    store.updateFrom(null);
    expect(store.manifest, isNull);
    expect(store.isLoaded, isFalse);
  });

  test('битые поля не роняют парсинг', () async {
    final api = fakeApi((request) async => http.Response('unused', 500));
    final store = ManifestStore(api: api);

    store.updateFrom({
      'tools': [
        {'name': 'x'},
        {'name': 'y', 'description': null},
      ],
      'primitives': [],
      'version': '0.1.0',
    });

    expect(store.manifest!.tools.map((tool) => tool.description), ['', '']);
  });
}
