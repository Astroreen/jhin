import 'package:http/http.dart' as http;

import '../tls/tls_trust.dart';

/// Fallback for platforms without `dart:io` or JS interop.
http.Client createHttpClient({TrustStore? trustStore}) =>
    throw UnsupportedError('HTTP client unavailable on this platform');