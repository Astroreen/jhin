import 'package:http/http.dart' as http;

import 'api/api_client.dart';
import 'auth/token_storage.dart';
import 'sse/sse_transport.dart';
import 'tls/tls_trust.dart';

/// Единая точка входа core-инфраструктуры для экранов T28–T31.
///
/// Связывает [api] (HTTP-контракт hub'а), [storage] (секреты/настройки),
/// [trustStore] (TOFU-pин TLS) и SSE-транспорт событий сессии.
class JhinClient {
  JhinClient._({
    required this.storage,
    required this.trustStore,
    required this.api,
    required SseTransport sse,
  }) : _sse = sse;

  /// Собирает клиент: поднимает [storage] (платформенный выбор) и http/SSE
  /// транспорты с TOFU-pinning через [trustStore].
  ///
  /// [baseUrl] — URL hub'а; если null, берётся из storage. [onSseStatus] —
  /// колбэк статуса SSE (connecting/connected/reconnecting/closed).
  factory JhinClient({
    Uri? baseUrl,
    TokenStorage? storage,
    TrustStore? trustStore,
    http.Client? httpClient,
    SseStatusCallback? onSseStatus,
    SseRetryPolicy? retryPolicy,
  }) {
    final store = storage ?? createTokenStorage();
    final trust = trustStore ?? TrustStore();
    final resolved = baseUrl ?? Uri.parse('https://localhost:8443');
    final api = HttpApiClient(
      baseUrl: resolved,
      client: httpClient,
      trustStore: trust,
    );
    return JhinClient._(
      storage: store,
      trustStore: trust,
      api: api,
      sse: createSseTransport(
        trustStore: trust,
        onStatus: onSseStatus,
        retryPolicy: retryPolicy,
      ),
    );
  }

  /// Асинхронная сборка: поднимает pin и токен из [storage].
  static Future<JhinClient> create({
    Uri? baseUrl,
    TokenStorage? storage,
    TrustStore? trustStore,
    http.Client? httpClient,
    SseStatusCallback? onSseStatus,
    SseRetryPolicy? retryPolicy,
  }) async {
    final store = storage ?? createTokenStorage();
    final trust = trustStore ?? TrustStore();
    final pinned = await store.readPinnedFingerprint();
    if (pinned != null && isValidFingerprint(pinned)) {
      trust.pin(pinned);
    }
    var base = baseUrl;
    if (base == null) {
      final saved = await store.readServerUrl();
      if (saved != null && saved.isNotEmpty) {
        base = Uri.tryParse(saved);
      }
    }
    final client = JhinClient(
      baseUrl: base,
      storage: store,
      trustStore: trust,
      httpClient: httpClient,
      onSseStatus: onSseStatus,
      retryPolicy: retryPolicy,
    );
    client.api.token = await store.readToken();
    return client;
  }

  final TokenStorage storage;
  final TrustStore trustStore;
  final ApiClient api;
  final SseTransport _sse;

  /// Поток событий сессии (`GET /sessions/{id}/events`) с автоматическим
  /// реконнектом; [fromSeq] — seq >= N (null — вся история).
  Stream<SseEvent> sessionEvents(String sessionId, {int? fromSeq}) =>
      _sse.connect(
        '${api.baseUrl}/sessions/${Uri.encodeComponent(sessionId)}/events',
        token: api.token,
        fromSeq: fromSeq,
      );

  /// seq последнего доставленного SSE-события (для resume после рестарта клиента).
  int? get lastEventId => _sse.lastEventId;

  /// Подтверждение фингерпринта пользователем (TOFU): пин в память и в storage.
  Future<void> pinCertificate(String fingerprint) async {
    trustStore.pin(fingerprint);
    await storage.writePinnedFingerprint(fingerprint);
  }

  /// Выход: чистит токен/URL/пин и сбрасывает trust store.
  Future<void> signOut() async {
    api.token = null;
    trustStore.clear();
    await storage.clearAll();
  }

  /// Останавливает SSE и закрывает http-клиент.
  void close() {
    _sse.close();
    api.close();
  }
}
