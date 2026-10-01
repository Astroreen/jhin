import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import '../api/http_error.dart';
import '../tls/tls_trust.dart';
import 'sse_stream.dart';

/// Web SSE opener: fetch + ReadableStream (`package:web`).
///
/// No `EventSource` — custom headers (`Authorization`, `X-Jhin-Client`) are
/// required. [trustStore] is accepted for API symmetry and ignored: browsers
/// never expose the peer certificate to JavaScript, so app-level TOFU pinning
/// is impossible (documented in `tls_guard_web.dart`).
SseByteOpener createSseByteOpener({TrustStore? trustStore}) => _open;

Future<Stream<List<int>>> _open(
  Uri uri, {
  Map<String, String> headers = const {},
}) async {
  final requestHeaders = web.Headers();
  headers.forEach((name, value) => requestHeaders.append(name, value));
  final abort = web.AbortController();
  final response = await web.window
      .fetch(
        uri.toString().toJS,
        web.RequestInit(
          method: 'GET',
          headers: requestHeaders,
          signal: abort.signal,
        ),
      )
      .toDart;
  if (!response.ok) {
    var body = '';
    try {
      body = (await response.text().toDart).toDart;
    } catch (_) {
      // Unreadable body — the status code is what matters.
    }
    throw JhinHttpException.fromResponse(response.status, body);
  }
  return _readBody(response, abort);
}

/// Chunked `response.body` reader → `Stream<List<int>>` for the shared engine.
Stream<List<int>> _readBody(web.Response response, web.AbortController abort) {
  final controller = StreamController<List<int>>();
  web.ReadableStreamDefaultReader? reader;

  controller.onListen = () async {
    try {
      final body = response.body;
      if (body == null) {
        await controller.close();
        return;
      }
      reader = body.getReader() as web.ReadableStreamDefaultReader;
      while (true) {
        final result = await reader!.read().toDart;
        if (result.done) {
          break;
        }
        final value = result.value;
        if (value != null) {
          controller.add((value as JSUint8Array).toDart);
        }
      }
      await controller.close();
    } catch (error) {
      if (!controller.isClosed) {
        controller
          ..addError(error)
          ..close();
      }
    }
  };

  controller.onCancel = () async {
    try {
      abort.abort();
    } catch (_) {
      // Already finished.
    }
    try {
      await reader?.cancel().toDart;
    } catch (_) {
      // Reader already closed.
    }
  };

  return controller.stream;
}