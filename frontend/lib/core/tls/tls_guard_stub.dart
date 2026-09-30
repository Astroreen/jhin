import 'package:http/http.dart' as http;

import 'tls_trust.dart';

/// Fallback for platforms without `dart:io` or JS interop: no TLS inspection.
bool get supportsTlsPinning => false;

/// Unsupported on this platform.
http.Client createTlsPinnedClient(TrustStore trust) =>
    throw UnsupportedError('TLS-pinned HTTP client unavailable on this platform');