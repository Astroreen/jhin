import 'package:http/http.dart' as http;

import 'tls_trust.dart';

/// Web cannot inspect TLS peer certificates: the browser never exposes them
/// to JavaScript, so app-level TOFU pinning is impossible. TLS trust is owned
/// by the browser (its self-signed certificate warning is accepted once by
/// the user at the browser level).
bool get supportsTlsPinning => false;

/// Documented no-op: returns a plain browser client and ignores [trust].
http.Client createTlsPinnedClient(TrustStore trust) => http.Client();