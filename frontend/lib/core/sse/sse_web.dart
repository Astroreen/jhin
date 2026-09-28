import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import '../api/api_client.dart';
import '../tls/tls_trust.dart';
import 'sse_transport.dart';

/// Web-реализация SSE-транспорта: fetch + ReadableStream (`package:web`).
///
/// Никакого EventSource — нужны `Authorization`-заголовки. App-level TOFU-pinning
/// на web невозможен (браузер не отдаёт JS'у сертификат) — [trustStore]
/// принимается для симметрии API и игнорируется; доверие — browser-level.
SseTransport createSseTransport({
  TrustStore? trustStore,
  SseStatusCallback? onStatus,
  SseRetryPolicy? retryPolicy,
}) =>
    ReconnectingSseTransport(
      _open,
      onStatus: onStatus,
      retryPolicy: retryPolicy,
    );

Future<Stream<List<int>>> _open(Uri uri, {String? token}) async {
  final headers = web.Headers()
    ..append('Accept', 'text/event-stream')
    ..append('Cache-Control', 'no-cache');
  if (token != null && token.isNotEmpty) {
    headers.append('Authorization', 'Bearer $token');
  }
  final abort = web.AbortController();
  final response = await web.window
      .fetch(
        uri.toString().toJS,
        web.RequestInit(method: 'GET', headers: headers, signal: abort.signal),
      )
      .toDart;
  if (!response.ok) {
    var body = '';
    try {
      body = (await response.text().toDart).toDart;
    } catch (_) {
      // тело не прочиталось — код ошибки всё равно вернём
    }
    throw _httpError(response.status, body);
  }
  return _readBody(response, abort);
}

/// Чанковое чтение `response.body` → `Stream<List<int>>` для общего движка.
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
      // уже завершён
    }
    try {
      await reader?.cancel().toDart;
    } catch (_) {
      // читатель уже закрыт
    }
  };

  return controller.stream;
}

ApiClientException _httpError(int statusCode, String body) {
  String? error;
  try {
    final decoded = jsonDecode(body);
    if (decoded is Map<String, dynamic> && decoded['error'] is String) {
      error = decoded['error'] as String;
    }
  } catch (_) {
    // тело не JSON
  }
  return ApiClientException(statusCode, error);
}
