import 'package:http/http.dart' as http;

import '../tls/tls_trust.dart';
import 'http_client_stub.dart'
    if (dart.library.io) 'http_client_io.dart'
    if (dart.library.js_interop) 'http_client_web.dart' as platform;

/// Creates the platform HTTP client.
///
/// When [trustStore] is given, TLS peer certificates are TOFU-pinned through
/// `core/tls` (IO only — see `supportsTlsPinning`). Without a trust store the
/// client uses the platform default TLS trust.
http.Client createHttpClient({TrustStore? trustStore}) =>
    platform.createHttpClient(trustStore: trustStore);