import 'dart:convert';
import 'dart:io';

import '../api/api_client.dart';
import '../tls/tls_trust.dart';
import 'sse_transport.dart';

/// IO-реализация SSE-транспорта (`dart:io HttpClient`).
///
/// Bearer-заголовок, `Accept: text/event-stream`, TOFU-pinning через
/// [trustStore] (badCertificateCallback → `certFingerprint(cert.der)`).
/// Несовпадение пина → [TlsPinMismatchException] (фатально, не ретраится).
SseTransport createSseTransport({
  TrustStore? trustStore,
  SseStatusCallback? onStatus,
  SseRetryPolicy? retryPolicy,
}) {
  final client = HttpClient();
  if (trustStore != null) {
    client.badCertificateCallback = (cert, host, port) =>
        trustStore.verify(certFingerprint(cert.der));
  }
  return ReconnectingSseTransport(
    (uri, {String? token}) => _open(client, uri, token, trustStore),
    onStatus: onStatus,
    retryPolicy: retryPolicy,
    onDispose: client.close,
  );
}

Future<Stream<List<int>>> _open(
  HttpClient client,
  Uri uri,
  String? token,
  TrustStore? trustStore,
) async {
  try {
    final request = await client.getUrl(uri);
    request.headers
      ..set(HttpHeaders.acceptHeader, 'text/event-stream')
      ..set(HttpHeaders.cacheControlHeader, 'no-cache');
    if (token != null && token.isNotEmpty) {
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    }
    final response = await request.close();
    if (response.statusCode != HttpStatus.ok) {
      final body = await response.transform(utf8.decoder).join();
      throw _httpError(response.statusCode, body);
    }
    return response;
  } on HandshakeException {
    final rejected = trustStore?.rejectedFingerprint;
    if (rejected != null) {
      throw TlsPinMismatchException(
        fingerprint: rejected,
        pinnedFingerprint: trustStore?.pinnedFingerprint,
      );
    }
    rethrow;
  }
}

ApiClientException _httpError(int statusCode, String body) {
  String? error;
  try {
    final decoded = jsonDecode(body);
    if (decoded is Map<String, dynamic> && decoded['error'] is String) {
      error = decoded['error'] as String;
    }
  } on FormatException {
    // тело не JSON
  }
  return ApiClientException(statusCode, error);
}
