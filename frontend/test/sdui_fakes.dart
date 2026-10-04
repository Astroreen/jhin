import 'dart:async';

import 'package:jhin/core/api/jhin_transport.dart';
import 'package:jhin/core/sse/sse_stream.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

import 'package:jhin/core/tls/tls_trust.dart';

/// One recorded transport call of [ScriptedTransport].
class ScriptedCall {
  const ScriptedCall(this.method, this.path, this.body);

  final String method;
  final String path;
  final Object? body;

  @override
  String toString() => '$method $path $body';
}

/// Scripted [JhinTransport] for SDUI tests: route JSON responses by path,
/// gate responses behind completers, record every call (including the exact
/// POST bodies), and hand out in-memory SSE streams per topic.
class ScriptedTransport implements JhinTransport {
  ScriptedTransport({String baseUrl = 'http://scripted'})
      : baseUrl = Uri.parse(baseUrl);

  /// Path to JSON response (or an error object to throw).
  final Map<String, Object> routes = {};

  /// Path to a gate: while incomplete, `getJson` waits for it.
  final Map<String, Completer<Map<String, dynamic>>> gates = {};

  /// Path to the SSE stream handed out by [sse].
  final Map<String, StreamController<Map<String, dynamic>>> streams = {};

  /// Optional handler for `postJson`; defaults to an empty response.
  Map<String, dynamic> Function(String path, Object? body)? onPost;

  /// Every recorded call, in order.
  final List<ScriptedCall> calls = [];

  @override
  final Uri baseUrl;

  @override
  final TrustStore trustStore = TrustStore();

  @override
  String? token;

  /// The (single) SSE stream of [topic], created on demand.
  StreamController<Map<String, dynamic>> streamFor(String topic) =>
      streams.putIfAbsent(
          topic, () => StreamController<Map<String, dynamic>>.broadcast());

  @override
  Future<HealthInfo> health(String url) async {
    calls.add(ScriptedCall('GET', '/_jhin/health', null));
    return const HealthInfo(
        status: 'ok', kernel: '0.2.0', api: 1, plugins: [], failed: []);
  }

  @override
  Future<Map<String, dynamic>> getJson(String path) async {
    calls.add(ScriptedCall('GET', path, null));
    final gate = gates[path];
    if (gate != null) return gate.future;
    final route = routes[path];
    if (route is Exception) throw route;
    if (route is Map<String, dynamic>) return route;
    if (route is Map) return Map<String, dynamic>.from(route);
    throw StateError('no scripted route for $path');
  }

  @override
  Future<List<dynamic>> getJsonList(String path) async {
    calls.add(ScriptedCall('GET', path, null));
    final route = routes[path];
    if (route is Exception) throw route;
    if (route is List) return route;
    throw StateError('no scripted list route for $path');
  }

  @override
  Future<Map<String, dynamic>> postJson(String path, Object body) async {
    calls.add(ScriptedCall('POST', path, body));
    return onPost?.call(path, body) ?? <String, dynamic>{};
  }

  @override
  Stream<Map<String, dynamic>> sse(
    String path, {
    void Function(SseConnectionStatus status)? onStatus,
  }) {
    calls.add(ScriptedCall('SSE', path, null));
    onStatus?.call(SseConnectionStatus.connected);
    return streamFor(path).stream;
  }

  @override
  void close() {}
}

/// A §8.2-shaped bootstrap payload with arbitrary inline screens.
Map<String, dynamic> sduiPayload({
  required String entry,
  required Map<String, Map<String, dynamic>> screens,
  String? screenEndpoint,
  Map<String, dynamic>? fallbacks,
  String title = 'Jhin',
}) =>
    {
      'api': 1,
      'empty': false,
      'title': title,
      'entry': entry,
      'screens': [
        for (final screen in screens.entries)
          {'id': screen.key, 'node': screen.value},
      ],
      'screenEndpoint': ?screenEndpoint,
      'fallbacks': ?fallbacks,
    };

/// A [RenderContext] over [state] with no-op side channels — for registry
/// level rendering tests (expressions, unsupported nodes).
RenderContext testRenderContext(UiState state) => RenderContext(
      state: state,
      registry: UiRegistry.standard(),
      patches: {},
      setState: (id, value) => state.setValue(id, value),
      patch: (id, props) {},
      navigate: (screen) {},
      dispatch: (action) async {},
      openStream: (topic, {onStatus}) => const Stream.empty(),
      runDirectives: (directives) async {},
      confirm: (message, onConfirm) {},
    );
