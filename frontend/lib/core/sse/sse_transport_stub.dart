import '../tls/tls_trust.dart';
import 'sse_transport.dart';

/// Фолбэк SSE-транспорта для платформ без dart:io и JS-интеропа.
SseTransport createSseTransport({
  TrustStore? trustStore,
  SseStatusCallback? onStatus,
  SseRetryPolicy? retryPolicy,
}) =>
    throw UnsupportedError('SSE transport unavailable on this platform');
