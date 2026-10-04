import 'dart:convert';

import 'package:http/http.dart' as http;

import '../sse/sse_client.dart';
import '../sse/sse_stream.dart';
import '../tls/tls_trust.dart';
import 'http_client.dart';
import 'http_error.dart';

export 'http_error.dart';

/// Client version advertised in `X-Jhin-Client` — the semver part of the
/// `version:` field in `pubspec.yaml`. Locked to it by `client_header_test`.
const String kJhinClientVersion = '0.1.0';

/// Client capabilities advertised in `X-Jhin-Client` (D-22, api 1).
///
/// Names are additive-only across frontend releases: `sse`, `tls_pinning`,
/// `secure_storage`, `open_url`, `multi_profile`. The server degrades features
/// per capability (§8.7); unknown names are ignored.
const List<String> kJhinClientCaps = [
  'sse',
  'tls_pinning',
  'secure_storage',
  'open_url',
  'multi_profile',
];

/// Builds the `X-Jhin-Client` header value (D-22).
///
/// Format is strict: `api=1; version=x.y.z; caps=a,b,c`.
String buildXJhinClientHeader({String? version}) =>
    'api=1; version=${version ?? kJhinClientVersion}; '
    'caps=${kJhinClientCaps.join(',')}';

/// One loaded plugin in a `/_jhin/health` payload (§6).
class HealthPlugin {
  const HealthPlugin({required this.id, this.version, this.name});

  factory HealthPlugin.fromJson(Map<String, dynamic> json) => HealthPlugin(
        id: json['id'] as String? ?? '',
        version: json['version'] as String?,
        name: json['name'] as String?,
      );

  final String id;
  final String? version;
  final String? name;
}

/// One failed plugin in a `/_jhin/health` payload (§6).
class HealthPluginFailure {
  const HealthPluginFailure({required this.id, this.reason});

  factory HealthPluginFailure.fromJson(Map<String, dynamic> json) =>
      HealthPluginFailure(
        id: json['id'] as String? ?? '',
        reason: json['reason'] as String?,
      );

  final String id;
  final String? reason;
}

/// `GET /_jhin/health` payload (§6):
/// `{"status":"ok","kernel":"0.2.0","api":1,"plugins":[…],"failed":[…]}`.
class HealthInfo {
  const HealthInfo({
    required this.status,
    required this.kernel,
    required this.api,
    required this.plugins,
    required this.failed,
  });

  /// Tolerant parse: missing fields fall back to neutral defaults.
  factory HealthInfo.fromJson(Map<String, dynamic> json) => HealthInfo(
        status: json['status'] as String? ?? 'unknown',
        kernel: json['kernel'] as String? ?? '',
        api: (json['api'] as num?)?.toInt() ?? 0,
        plugins: _objects(json['plugins']).map(HealthPlugin.fromJson).toList(),
        failed: _objects(json['failed'])
            .map(HealthPluginFailure.fromJson)
            .toList(),
      );

  final String status;
  final String kernel;
  final int api;
  final List<HealthPlugin> plugins;
  final List<HealthPluginFailure> failed;

  static List<Map<String, dynamic>> _objects(Object? value) =>
      value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];
}

/// HTTP + SSE transport of a Jhin server.
///
/// Every request (including the SSE handshake) carries `X-Jhin-Client`
/// (D-22) and, when [token] is set, `Authorization: Bearer <token>`.
/// Non-2xx responses throw [JhinHttpException] (status code + body);
/// a TLS pin mismatch throws [CertificateMismatch] (blocking).
class JhinTransport {
  /// Creates a transport for the server at [baseUrl].
  ///
  /// [trustStore] defaults to a fresh TOFU [TrustStore] shared by the HTTP
  /// client and the SSE opener; inject one to persist pins across restarts.
  factory JhinTransport({
    required Uri baseUrl,
    TrustStore? trustStore,
    String? token,
    http.Client? client,
    SseByteOpener? sseOpener,
    SseRetryPolicy? retryPolicy,
  }) {
    final trust = trustStore ?? TrustStore();
    return JhinTransport._(
      _normalize(baseUrl),
      trust,
      token,
      client ?? createHttpClient(trustStore: trust),
      sseOpener ?? createSseByteOpener(trustStore: trust),
      retryPolicy ?? const SseRetryPolicy(),
    );
  }

  JhinTransport._(
    this.baseUrl,
    this.trustStore,
    this.token,
    this._client,
    this._sseOpener,
    this._retryPolicy,
  );

  /// Base URL of the server (no trailing slash).
  final Uri baseUrl;

  /// TOFU trust store backing TLS pinning on IO platforms.
  final TrustStore trustStore;

  /// Device token sent as `Authorization: Bearer <token>` when set.
  String? token;

  final http.Client _client;
  final SseByteOpener _sseOpener;
  final SseRetryPolicy _retryPolicy;

  /// Probes `GET {url}/_jhin/health` against an arbitrary server base [url]
  /// (used before a profile exists). Never authenticated (§6).
  Future<HealthInfo> health(String url) async {
    final base = _normalize(Uri.parse(url));
    final response =
        await _send('GET', Uri.parse('$base/_jhin/health'), auth: false);
    _ensureSuccess(response);
    return HealthInfo.fromJson(_decodeObject(response.body));
  }

  /// `GET {baseUrl}{path}` → decoded JSON object.
  Future<Map<String, dynamic>> getJson(String path) async {
    final response = await _send('GET', _resolve(path));
    _ensureSuccess(response);
    return _decodeObject(response.body);
  }

  /// `GET {baseUrl}{path}` → decoded JSON list (T69: the session list of
  /// `GET /sessions` is a bare array).
  Future<List<dynamic>> getJsonList(String path) async {
    final response = await _send('GET', _resolve(path));
    _ensureSuccess(response);
    return _decodeList(response.body);
  }

  /// `POST {baseUrl}{path}` with a JSON-encoded [body] → decoded JSON object.
  Future<Map<String, dynamic>> postJson(String path, Object body) async {
    final response = await _send('POST', _resolve(path), body: body);
    _ensureSuccess(response);
    return _decodeObject(response.body);
  }

  /// `GET {baseUrl}{path}` as an SSE stream of JSON objects.
  ///
  /// Reconnects with exponential backoff capped at 30 seconds and resumes via
  /// `Last-Event-ID`; 4xx and [CertificateMismatch] are fatal stream errors.
  /// [onStatus] reports the connection lifecycle (for UI indicators).
  Stream<Map<String, dynamic>> sse(
    String path, {
    void Function(SseConnectionStatus status)? onStatus,
  }) {
    final headers = <String, String>{
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Jhin-Client': buildXJhinClientHeader(),
      ..._authHeader(),
    };
    return openSseJsonStream(
      _resolve(path),
      open: _sseOpener,
      headers: headers,
      retryPolicy: _retryPolicy,
      onStatus: onStatus,
    );
  }

  /// Closes the underlying HTTP client.
  void close() => _client.close();

  Uri _resolve(String path) {
    if (!path.startsWith('/')) {
      throw ArgumentError.value(path, 'path', 'must start with "/"');
    }
    return Uri.parse('$baseUrl$path');
  }

  Map<String, String> _authHeader() {
    final value = token;
    if (value == null || value.isEmpty) {
      return const {};
    }
    return {'Authorization': 'Bearer $value'};
  }

  Future<http.Response> _send(
    String method,
    Uri uri, {
    Object? body,
    bool auth = true,
  }) async {
    final request = http.Request(method, uri)
      ..headers['X-Jhin-Client'] = buildXJhinClientHeader();
    if (auth) {
      request.headers.addAll(_authHeader());
    }
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final streamed = await _client.send(request);
    return http.Response.fromStream(streamed);
  }

  void _ensureSuccess(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return;
    }
    throw JhinHttpException.fromResponse(response.statusCode, response.body);
  }

  static Map<String, dynamic> _decodeObject(String body) {
    if (body.isEmpty) {
      return <String, dynamic>{};
    }
    final decoded = jsonDecode(body);
    if (decoded is! Map<String, dynamic>) {
      throw FormatException('expected JSON object, got: $body');
    }
    return decoded;
  }

  static List<dynamic> _decodeList(String body) {
    if (body.isEmpty) {
      return <dynamic>[];
    }
    final decoded = jsonDecode(body);
    if (decoded is! List) {
      throw FormatException('expected JSON list, got: $body');
    }
    return decoded;
  }

  static Uri _normalize(Uri value) {
    final text = value.toString();
    return Uri.parse(
        text.endsWith('/') ? text.substring(0, text.length - 1) : text);
  }
}