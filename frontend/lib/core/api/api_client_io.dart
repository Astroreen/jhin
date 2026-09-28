import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import '../tls/tls_trust.dart';

/// IO-клиент: `dart:io HttpClient` с TOFU-pinning (badCertificateCallback).
///
/// Смена сертификата при запиненном пине → HandshakeException →
/// [TlsPinMismatchException] (возможен MITM).
http.Client createPlatformHttpClient({TrustStore? trustStore}) {
  if (trustStore == null) {
    return http.Client();
  }
  final io = HttpClient()
    ..badCertificateCallback = (cert, host, port) =>
        trustStore.verify(certFingerprint(cert.der));
  return _TlsGuardClient(IOClient(io), trustStore);
}

class _TlsGuardClient extends http.BaseClient {
  _TlsGuardClient(this._inner, this._trustStore);

  final http.Client _inner;
  final TrustStore _trustStore;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    try {
      return await _inner.send(request);
    } on HandshakeException {
      final rejected = _trustStore.rejectedFingerprint;
      if (rejected != null) {
        throw TlsPinMismatchException(
          fingerprint: rejected,
          pinnedFingerprint: _trustStore.pinnedFingerprint,
        );
      }
      rethrow;
    }
  }

  @override
  void close() => _inner.close();
}
