import 'dart:convert';
import 'dart:io';

import '../api/http_error.dart';
import '../tls/tls_guard_io.dart';
import '../tls/tls_trust.dart';
import 'sse_stream.dart';

/// IO SSE opener: `dart:io HttpClient` with TOFU pinning via [trustStore]
/// (`badCertificateCallback` → `certFingerprint(cert.der)`). A rejected pin
/// surfaces as [CertificateMismatch] (fatal for the stream).
SseByteOpener createSseByteOpener({TrustStore? trustStore}) =>
    (Uri uri, {Map<String, String> headers = const {}}) =>
        _open(uri, headers, trustStore);

Future<Stream<List<int>>> _open(
  Uri uri,
  Map<String, String> headers,
  TrustStore? trustStore,
) async {
  final client = (trustStore == null)
      ? HttpClient()
      : createPinnedIoHttpClient(trustStore);
  try {
    final request = await client.getUrl(uri);
    headers.forEach(request.headers.set);
    final response = await request.close();
    if (response.statusCode != HttpStatus.ok) {
      final body = await response.transform(utf8.decoder).join();
      throw JhinHttpException.fromResponse(response.statusCode, body);
    }
    // No force: the in-flight response keeps draining, idle sockets close.
    client.close();
    return response;
  } catch (error) {
    client.close(force: true);
    if (trustStore != null) {
      throw mapHandshakeFailure(trustStore, error);
    }
    rethrow;
  }
}