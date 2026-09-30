import '../tls/tls_trust.dart';
import 'sse_client_stub.dart'
    if (dart.library.io) 'sse_client_io.dart'
    if (dart.library.js_interop) 'sse_client_web.dart' as platform;
import 'sse_stream.dart';

/// Creates the platform SSE byte opener.
///
/// IO: `dart:io HttpClient` with TOFU pinning via [trustStore]; web: fetch +
/// ReadableStream (`package:web`) — pinning is impossible there (see
/// `tls_guard_web.dart`).
SseByteOpener createSseByteOpener({TrustStore? trustStore}) =>
    platform.createSseByteOpener(trustStore: trustStore);