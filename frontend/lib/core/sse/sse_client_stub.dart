import '../tls/tls_trust.dart';
import 'sse_stream.dart';

/// Fallback for platforms without `dart:io` or JS interop.
SseByteOpener createSseByteOpener({TrustStore? trustStore}) =>
    throw UnsupportedError('SSE transport unavailable on this platform');