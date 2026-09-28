import 'package:http/http.dart' as http;

import '../tls/tls_trust.dart';

/// Фолбэк для платформ без dart:io и JS-интеропа.
http.Client createPlatformHttpClient({TrustStore? trustStore}) =>
    throw UnsupportedError('HTTP client unavailable on this platform');
