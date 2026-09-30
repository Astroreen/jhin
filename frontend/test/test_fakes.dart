import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/api/jhin_transport.dart';
import 'package:jhin/core/tls/tls_trust.dart';

/// In-memory [JhinTransport] test double: scripted bootstrap / health
/// payloads and a switchable [error] (poisoned transport when set).
///
/// Implements the transport interface so the production wiring stays
/// untouched; SSE and POST are not scripted and throw.
class FakeTransport implements JhinTransport {
  FakeTransport({this.bootstrap, this.healthInfo, this.error});

  /// Payload returned by `GET /_jhin/bootstrap`.
  Map<String, dynamic>? bootstrap;

  /// Payload returned by `GET /_jhin/health`.
  HealthInfo? healthInfo;

  /// When set, every call throws it (poisoned transport).
  Object? error;

  /// Recorded call names, for assertions.
  final List<String> calls = [];

  @override
  final Uri baseUrl = Uri.parse('http://fake');

  @override
  final TrustStore trustStore = TrustStore();

  @override
  String? token;

  @override
  Future<HealthInfo> health(String url) async {
    calls.add('health:$url');
    final failure = error;
    if (failure != null) throw failure;
    return healthInfo ??
        const HealthInfo(
          status: 'ok',
          kernel: '0.2.0',
          api: 1,
          plugins: [],
          failed: [],
        );
  }

  @override
  Future<Map<String, dynamic>> getJson(String path) async {
    calls.add('getJson:$path');
    final failure = error;
    if (failure != null) throw failure;
    return bootstrap!;
  }

  @override
  Future<Map<String, dynamic>> postJson(String path, Object body) async {
    calls.add('postJson:$path');
    throw UnimplementedError('not scripted in FakeTransport');
  }

  @override
  Stream<Map<String, dynamic>> sse(String path) {
    calls.add('sse:$path');
    throw UnimplementedError('not scripted in FakeTransport');
  }

  @override
  void close() {}
}

/// One in-process fixture server: answers `/_jhin/health` and
/// `/_jhin/bootstrap` from the given payloads (null → 404 `not_found`),
/// exactly like a bare kernel / fixture UI would (§6, §8.2).
class JhinFixture {
  JhinFixture._(this._server, this.health, this.bootstrap);

  static Future<JhinFixture> start({
    Map<String, dynamic>? bootstrap,
    Map<String, dynamic> health = const {
      'status': 'ok',
      'kernel': '0.2.0',
      'api': 1,
      'plugins': <Object?>[],
      'failed': <Object?>[],
    },
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final fixture = JhinFixture._(server, health, bootstrap);
    server.listen(fixture._handle);
    return fixture;
  }

  final HttpServer _server;
  final Map<String, dynamic> health;
  final Map<String, dynamic>? bootstrap;

  /// Base URL of the fixture (`http://127.0.0.1:<port>`).
  String get baseUrl => 'http://127.0.0.1:${_server.port}';

  /// Stops the fixture — subsequent requests fail at the socket level.
  Future<void> close() => _server.close(force: true);

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    try {
      response.headers.contentType = ContentType.json;
      final Map<String, dynamic>? payload = switch (request.uri.path) {
        '/_jhin/health' => health,
        '/_jhin/bootstrap' => bootstrap,
        _ => null,
      };
      if (payload == null) {
        response.statusCode = HttpStatus.notFound;
        response.write(jsonEncode({'error': 'not_found'}));
      } else {
        response.write(jsonEncode(payload));
      }
    } finally {
      await response.close();
    }
  }
}

/// A §8.2 bootstrap payload with one inline screen — `marker` is the text
/// the generic screen renderer must surface, so two payloads with different
/// markers render two distinguishable trees.
Map<String, dynamic> bootstrapPayload({
  required String entry,
  required String marker,
  String title = 'Fixture',
  Map<String, dynamic>? offline,
}) =>
    {
      'api': 1,
      'empty': false,
      'title': title,
      'entry': entry,
      'screens': [
        {
          'id': entry,
          'node': {
            'type': 'screen',
            'title': title,
            'body': {
              'type': 'container',
              'children': [
                {'type': 'text', 'text': marker},
              ],
            },
          },
        },
      ],
      if (offline != null)
        'fallbacks': {
          'offline': offline,
        },
    };

/// The kernel bootstrap fallback (D-7): a bare kernel with no UI plugin.
Map<String, dynamic> kernelBootstrap({String kernel = '0.2.0'}) => {
      'api': 1,
      'empty': true,
      'kernel': kernel,
      'plugins': <Object?>[],
      'message': 'This server has no UI plugin installed.',
    };

/// Cached `fallbacks.offline` art (§8.7) — server-authored, fixture-served.
Map<String, dynamic> offlineFallback({String marker = 'offline-art'}) => {
      'type': 'card',
      'title': 'Offline',
      'children': [
        {'type': 'text', 'text': marker},
      ],
    };

/// Burns pending fake-zone timers (the real `HttpClient` schedules a 15 s
/// connection-idle timer on every response, and under the widget-test
/// binding that timer lands in the fake zone).
///
/// Call once at the end of a test that performed real HTTP.
Future<void> flushConnectionTimers(WidgetTester tester) =>
    tester.pump(const Duration(seconds: 30));

/// Polls the real event loop until [finder] matches.
///
/// Real HTTP under the fake-async widget binding only completes inside
/// `runAsync`; this pumps frames between real-event-loop ticks.
Future<void> pumpUntilFound(
  WidgetTester tester,
  Finder finder, {
  int attempts = 100,
}) async {
  for (var i = 0; i < attempts; i++) {
    if (finder.evaluate().isNotEmpty) return;
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump();
  }
  fail('Timed out waiting for $finder');
}

/// Polls the real event loop until [finder] matches nothing.
Future<void> pumpUntilGone(
  WidgetTester tester,
  Finder finder, {
  int attempts = 100,
}) async {
  for (var i = 0; i < attempts; i++) {
    if (finder.evaluate().isEmpty) return;
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump();
  }
  fail('Timed out waiting for $finder to disappear');
}
