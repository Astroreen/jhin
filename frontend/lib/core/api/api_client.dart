import 'dart:convert';

import 'package:http/http.dart' as http;

import '../tls/tls_trust.dart';
import 'api_client_stub.dart'
    if (dart.library.io) 'api_client_io.dart'
    if (dart.library.js_interop) 'api_client_web.dart' as platform;

/// Создаёт http-клиент платформы.
///
/// IO (Linux desktop/Android): поверх `dart:io HttpClient` с
/// `badCertificateCallback` — TOFU-pinning через [TrustStore] (см. `tls_trust`).
/// Web: обычный браузерный клиент; app-level пин невозможен (браузер не отдаёт
/// JS'у сертификат) — доверие на уровне браузера, задокументировано в `tls_trust`.
http.Client createPlatformHttpClient({TrustStore? trustStore}) =>
    platform.createPlatformHttpClient(trustStore: trustStore);

/// Ошибка HTTP-уровня: non-2xx ответ backend'а.
///
/// [statusCode] — HTTP-код; [error] — код из тела `{"error":"<code>"}`
/// (`invalid_code`, `code_used`, `code_expired`, `bad_request`, `rate_limited`,
/// `not_found`, `unauthorized`, `forbidden`, `unknown_format`,
/// `restart manually`...), null если тело не в этом формате.
class ApiClientException implements Exception {
  const ApiClientException(this.statusCode, [this.error]);

  final int statusCode;
  final String? error;

  @override
  String toString() => 'ApiClientException($statusCode, error: $error)';
}

/// `GET /health` → `{"status":"UP"}` (анонимный).
class HealthStatus {
  const HealthStatus({required this.status});

  factory HealthStatus.fromJson(Map<String, dynamic> json) =>
      HealthStatus(status: json['status'] as String);

  final String status;
}

/// `POST /enroll` → plaintext device-токен возвращается ровно один раз.
class EnrollResult {
  const EnrollResult({
    required this.deviceToken,
    required this.accountId,
    required this.accountName,
  });

  factory EnrollResult.fromJson(Map<String, dynamic> json) => EnrollResult(
        deviceToken: json['deviceToken'] as String,
        accountId: json['accountId'] as String,
        accountName: json['accountName'] as String,
      );

  final String deviceToken;
  final String accountId;
  final String accountName;
}

/// Сессия (`GET/POST/PATCH /sessions...`). `createdAt`/`updatedAt` — ISO-строки
/// Instant, `model`/`providerId` могут быть null (не выбраны).
class SessionInfo {
  const SessionInfo({
    required this.id,
    required this.title,
    required this.workdir,
    required this.model,
    required this.providerId,
    required this.createdAt,
    required this.updatedAt,
  });

  factory SessionInfo.fromJson(Map<String, dynamic> json) => SessionInfo(
        id: json['id'] as String,
        title: json['title'] as String,
        workdir: json['workdir'] as String,
        model: json['model'] as String?,
        providerId: json['providerId'] as String?,
        createdAt: json['createdAt'] as String,
        updatedAt: json['updatedAt'] as String,
      );

  final String id;
  final String title;
  final String workdir;
  final String? model;
  final String? providerId;
  final String createdAt;
  final String updatedAt;
}

/// Тело `POST /sessions`: title и workdir обязательны, model/providerId опциональны.
class CreateSession {
  const CreateSession({
    required this.title,
    required this.workdir,
    this.model,
    this.providerId,
  });

  final String title;
  final String workdir;
  final String? model;
  final String? providerId;

  Map<String, Object?> toJson() => {
        'title': title,
        'workdir': workdir,
        if (model != null) 'model': model,
        if (providerId != null) 'providerId': providerId,
      };
}

/// Тело `PATCH /sessions/{id}`: только явные поля (null = не менять).
class PatchSession {
  const PatchSession({this.title, this.model, this.providerId});

  final String? title;
  final String? model;
  final String? providerId;

  Map<String, Object?> toJson() => {
        if (title != null) 'title': title,
        if (model != null) 'model': model,
        if (providerId != null) 'providerId': providerId,
      };
}

/// Ответ messages/cancel: `runId` = null — активного run нет (cancel идемпотентен).
class RunRef {
  const RunRef({required this.runId});

  factory RunRef.fromJson(Map<String, dynamic> json) =>
      RunRef(runId: json['runId'] as String?);

  final String? runId;
}

/// Тело `POST /sessions/{id}/ui-action`: action обязателен, payload — любой
/// JSON-объект или null.
class UiAction {
  const UiAction({required this.action, this.payload});

  final String action;
  final Map<String, dynamic>? payload;

  Map<String, Object?> toJson() => {
        'action': action,
        if (payload != null) 'payload': payload,
      };
}

/// Ответ ui-action: seq нового события в event log сессии.
class UiActionAck {
  const UiActionAck({required this.seq});

  factory UiActionAck.fromJson(Map<String, dynamic> json) =>
      UiActionAck(seq: (json['seq'] as num).toInt());

  final int seq;
}

/// LLM-провайдер (БЕЗ apiKey: секрет не возвращается наружу).
class ProviderInfo {
  const ProviderInfo({
    required this.id,
    required this.accountId,
    required this.name,
    required this.format,
    required this.model,
    required this.baseUrl,
    required this.isDefault,
  });

  factory ProviderInfo.fromJson(Map<String, dynamic> json) => ProviderInfo(
        id: json['id'] as String,
        accountId: json['accountId'] as String,
        name: json['name'] as String,
        format: json['format'] as String,
        model: json['model'] as String,
        baseUrl: json['baseUrl'] as String?,
        isDefault: json['isDefault'] as bool,
      );

  final String id;
  final String accountId;
  final String name;
  final String format;
  final String model;
  final String? baseUrl;
  final bool isDefault;
}

/// Тело `POST /providers`: name/format/apiKey/model обязательны.
class CreateProvider {
  const CreateProvider({
    required this.name,
    required this.format,
    required this.apiKey,
    required this.model,
    this.baseUrl,
    this.isDefault,
  });

  final String name;
  final String format;
  final String apiKey;
  final String model;
  final String? baseUrl;
  final bool? isDefault;

  Map<String, Object?> toJson() => {
        'name': name,
        'format': format,
        'apiKey': apiKey,
        'model': model,
        if (baseUrl != null) 'baseUrl': baseUrl,
        if (isDefault != null) 'isDefault': isDefault,
      };
}

/// Ответ `POST /admin/reload`: 202 `{"status":"restarting"}`.
class ReloadAck {
  const ReloadAck({required this.status});

  factory ReloadAck.fromJson(Map<String, dynamic> json) =>
      ReloadAck(status: json['status'] as String);

  final String status;
}

/// HTTP-контракт hub'а Jhin (см. API-спеку в AGENTS/отчёте T27).
///
/// Базовый URL: `https://<host>:<port>` (прод-дефолт 8443). Все запросы кроме
/// [health] и [enroll] шлют `Authorization: Bearer <token>` (если токен задан).
/// Ошибки — [ApiClientException] с кодом из `{"error":"<code>"}`.
abstract interface class ApiClient {
  /// Базовый URL hub'а.
  Uri get baseUrl;

  /// Текущий device-токен (null до enroll); обновляется после [enroll].
  String? get token;
  set token(String? value);

  /// `GET /health` — анонимный.
  Future<HealthStatus> health();

  /// `POST /enroll` — анонимный; в ответе plaintext device-токен (сохранить в
  /// TokenStorage и присвоить [token]).
  Future<EnrollResult> enroll({
    required String code,
    required String deviceName,
  });

  Future<List<SessionInfo>> listSessions();

  Future<SessionInfo> createSession(CreateSession request);

  Future<SessionInfo> getSession(String id);

  Future<SessionInfo> patchSession(String id, PatchSession request);

  Future<void> deleteSession(String id);

  /// `POST /sessions/{id}/messages` — run асинхронный, в ответе runId.
  Future<RunRef> sendMessage(String sessionId, String text);

  /// `POST /sessions/{id}/cancel` — идемпотентен.
  Future<RunRef> cancelRun(String sessionId);

  Future<UiActionAck> sendUiAction(String sessionId, UiAction action);

  Future<List<ProviderInfo>> listProviders();

  Future<ProviderInfo> createProvider(CreateProvider request);

  Future<ProviderInfo> getProvider(String id);

  Future<void> deleteProvider(String id);

  /// `POST /admin/reload` — 202 restarting / 503 `restart manually` (dev-режим).
  Future<ReloadAck> reload();

  /// `GET /ui/manifest` (T32); пока эндпоинта нет — null (404, либо 401:
  /// backend маскирует 404 unmapped-путей через ERROR-dispatch → unauthorized).
  Future<Map<String, dynamic>?> getUiManifest();

  /// Закрывает http-клиент (вызывать при уничтожении приложения).
  void close();
}

/// Реализация на `package:http` (IO: с TOFU-pinning, web: browser client).
class HttpApiClient implements ApiClient {
  HttpApiClient({
    required Uri baseUrl,
    String? token,
    http.Client? client,
    TrustStore? trustStore,
  })  : baseUrl = _normalize(baseUrl),
        _token = token,
        _client = client ?? createPlatformHttpClient(trustStore: trustStore);

  @override
  final Uri baseUrl;

  String? _token;
  final http.Client _client;

  @override
  String? get token => _token;

  @override
  set token(String? value) => _token = value;

  @override
  Future<HealthStatus> health() async {
    final response = await _send('GET', '/health', auth: false);
    _ensureSuccess(response);
    return HealthStatus.fromJson(_decodeObject(response.body));
  }

  @override
  Future<EnrollResult> enroll({
    required String code,
    required String deviceName,
  }) async {
    final response = await _send(
      'POST',
      '/enroll',
      auth: false,
      body: {'code': code, 'deviceName': deviceName},
    );
    _ensureSuccess(response);
    return EnrollResult.fromJson(_decodeObject(response.body));
  }

  @override
  Future<List<SessionInfo>> listSessions() async {
    final response = await _send('GET', '/sessions');
    _ensureSuccess(response);
    return _decodeList(response.body)
        .map((item) => SessionInfo.fromJson(item))
        .toList(growable: false);
  }

  @override
  Future<SessionInfo> createSession(CreateSession request) async {
    final response = await _send('POST', '/sessions', body: request.toJson());
    _ensureSuccess(response);
    return SessionInfo.fromJson(_decodeObject(response.body));
  }

  @override
  Future<SessionInfo> getSession(String id) async {
    final response = await _send('GET', '/sessions/${_seg(id)}');
    _ensureSuccess(response);
    return SessionInfo.fromJson(_decodeObject(response.body));
  }

  @override
  Future<SessionInfo> patchSession(String id, PatchSession request) async {
    final response = await _send(
      'PATCH',
      '/sessions/${_seg(id)}',
      body: request.toJson(),
    );
    _ensureSuccess(response);
    return SessionInfo.fromJson(_decodeObject(response.body));
  }

  @override
  Future<void> deleteSession(String id) async {
    final response = await _send('DELETE', '/sessions/${_seg(id)}');
    _ensureSuccess(response);
  }

  @override
  Future<RunRef> sendMessage(String sessionId, String text) async {
    final response = await _send(
      'POST',
      '/sessions/${_seg(sessionId)}/messages',
      body: {'text': text},
    );
    _ensureSuccess(response);
    return RunRef.fromJson(_decodeObject(response.body));
  }

  @override
  Future<RunRef> cancelRun(String sessionId) async {
    final response =
        await _send('POST', '/sessions/${_seg(sessionId)}/cancel');
    _ensureSuccess(response);
    return RunRef.fromJson(_decodeObject(response.body));
  }

  @override
  Future<UiActionAck> sendUiAction(String sessionId, UiAction action) async {
    final response = await _send(
      'POST',
      '/sessions/${_seg(sessionId)}/ui-action',
      body: action.toJson(),
    );
    _ensureSuccess(response);
    return UiActionAck.fromJson(_decodeObject(response.body));
  }

  @override
  Future<List<ProviderInfo>> listProviders() async {
    final response = await _send('GET', '/providers');
    _ensureSuccess(response);
    return _decodeList(response.body)
        .map((item) => ProviderInfo.fromJson(item))
        .toList(growable: false);
  }

  @override
  Future<ProviderInfo> createProvider(CreateProvider request) async {
    final response = await _send('POST', '/providers', body: request.toJson());
    _ensureSuccess(response);
    return ProviderInfo.fromJson(_decodeObject(response.body));
  }

  @override
  Future<ProviderInfo> getProvider(String id) async {
    final response = await _send('GET', '/providers/${_seg(id)}');
    _ensureSuccess(response);
    return ProviderInfo.fromJson(_decodeObject(response.body));
  }

  @override
  Future<void> deleteProvider(String id) async {
    final response = await _send('DELETE', '/providers/${_seg(id)}');
    _ensureSuccess(response);
  }

  @override
  Future<ReloadAck> reload() async {
    final response = await _send('POST', '/admin/reload');
    _ensureSuccess(response);
    return ReloadAck.fromJson(_decodeObject(response.body));
  }

  @override
  Future<Map<String, dynamic>?> getUiManifest() async {
    final response = await _send('GET', '/ui/manifest');
    // 404 — эндпоинта нет (до T32). 401 — тот же смысл: backend отдаёт
    // {"error":"unauthorized"} на любой unmapped-путь (stateless security +
    // ERROR-dispatch маскирует 404). Nullable-манифест — не повод падать.
    if (response.statusCode == 404 || response.statusCode == 401) {
      return null;
    }
    _ensureSuccess(response);
    if (response.body.isEmpty) {
      return null;
    }
    final decoded = jsonDecode(response.body);
    return decoded is Map<String, dynamic> ? decoded : null;
  }

  @override
  void close() => _client.close();

  Future<http.Response> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    bool auth = true,
  }) async {
    final request = http.Request(method, _uri(path));
    if (auth) {
      final value = _token;
      if (value != null && value.isNotEmpty) {
        request.headers['Authorization'] = 'Bearer $value';
      }
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
    throw ApiClientException(response.statusCode, _errorCode(response.body));
  }

  static String? _errorCode(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) {
        final error = decoded['error'];
        if (error is String) {
          return error;
        }
      }
    } on FormatException {
      // тело не JSON — кода нет
    }
    return null;
  }

  static Map<String, dynamic> _decodeObject(String body) {
    final decoded = jsonDecode(body);
    if (decoded is! Map<String, dynamic>) {
      throw FormatException('expected JSON object, got: $body');
    }
    return decoded;
  }

  static List<Map<String, dynamic>> _decodeList(String body) {
    final decoded = jsonDecode(body);
    if (decoded is! List) {
      throw FormatException('expected JSON array, got: $body');
    }
    return decoded.cast<Map<String, dynamic>>();
  }

  Uri _uri(String path) => Uri.parse(
      '${baseUrl.toString().replaceAll(RegExp(r'/+$'), '')}$path');

  static String _seg(String value) => Uri.encodeComponent(value);

  static Uri _normalize(Uri value) {
    final text = value.toString();
    return Uri.parse(text.endsWith('/') ? text.substring(0, text.length - 1) : text);
  }
}
