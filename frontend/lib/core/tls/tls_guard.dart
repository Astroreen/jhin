import 'package:http/http.dart' as http;

import 'tls_guard_stub.dart'
    if (dart.library.io) 'tls_guard_io.dart'
    if (dart.library.js_interop) 'tls_guard_web.dart' as platform;
import 'tls_trust.dart';

/// Whether this platform can inspect TLS peer certificates (TOFU pinning).
///
/// IO platforms (Linux/Android/desktop): yes. Web: no — browsers never expose
/// the peer certificate to JavaScript, so app-level pinning cannot be
/// enforced and TLS trust is owned by the browser.
bool get supportsTlsPinning => platform.supportsTlsPinning;

/// Creates an [http.Client] that TOFU-pins peer certificates via [trust].
///
/// IO: `dart:io HttpClient` with `badCertificateCallback`; a rejected peer
/// surfaces as [CertificateMismatch]. Web: a plain browser client — pinning
/// is a documented no-op there (see [supportsTlsPinning]).
http.Client createTlsPinnedClient(TrustStore trust) =>
    platform.createTlsPinnedClient(trust);