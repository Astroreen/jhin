import 'package:http/http.dart' as http;

import '../tls/tls_trust.dart';

/// Web HTTP client: the plain browser client. [trustStore] is ignored —
/// browsers own certificate trust and never expose the peer certificate to
/// JavaScript (documented in `tls_guard_web.dart`).
http.Client createHttpClient({TrustStore? trustStore}) => http.Client();