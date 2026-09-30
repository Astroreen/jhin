import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import 'tls_trust.dart';

/// IO platforms can inspect peer certificates during the handshake.
bool get supportsTlsPinning => true;

/// Creates a `dart:io` [HttpClient] that TOFU-pins peer certificates via
/// [trust] (`badCertificateCallback` over `certFingerprint(cert.der)`).
HttpClient createPinnedIoHttpClient(TrustStore trust) => HttpClient()
  ..badCertificateCallback =
      (cert, host, port) => trust.verify(certFingerprint(cert.der));

/// Maps a failed TLS handshake to [CertificateMismatch] when [trust] recorded
/// a rejected fingerprint; otherwise returns [error] unchanged so the caller
/// can rethrow it.
Object mapHandshakeFailure(TrustStore trust, Object error) {
  final rejected = trust.rejectedFingerprint;
  if (error is HandshakeException && rejected != null) {
    return CertificateMismatch(
      presented: rejected,
      pinned: trust.pinnedFingerprint,
    );
  }
  return error;
}

/// IO implementation: pinned [HttpClient] wrapped in an [IOClient] that
/// rewrites handshake failures into [CertificateMismatch].
http.Client createTlsPinnedClient(TrustStore trust) =>
    _PinnedClient(IOClient(createPinnedIoHttpClient(trust)), trust);

class _PinnedClient extends http.BaseClient {
  _PinnedClient(this._inner, this._trust);

  final http.Client _inner;
  final TrustStore _trust;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    try {
      return await _inner.send(request);
    } catch (error) {
      throw mapHandshakeFailure(_trust, error);
    }
  }

  @override
  void close() => _inner.close();
}