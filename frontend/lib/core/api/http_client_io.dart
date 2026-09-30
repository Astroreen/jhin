import 'package:http/http.dart' as http;

import '../tls/tls_guard_io.dart';
import '../tls/tls_trust.dart';

/// IO HTTP client: plain `package:http` client, or a TOFU-pinned one when
/// [trustStore] is given (see `tls_guard_io.dart`).
http.Client createHttpClient({TrustStore? trustStore}) =>
    trustStore == null ? http.Client() : createTlsPinnedClient(trustStore);