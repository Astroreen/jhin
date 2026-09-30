import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import '../api/http_error.dart';
import '../tls/tls_trust.dart';
import 'sse_parser.dart';

/// Opens the raw byte stream of an SSE response.
///
/// Non-2xx responses and TLS pin rejections must be thrown as
/// `JhinHttpException` / [CertificateMismatch] (both fatal for the stream);
/// network errors are thrown as-is and retried by [openSseJsonStream].
typedef SseByteOpener = Future<Stream<List<int>>> Function(
  Uri uri, {
  Map<String, String> headers,
});

/// Reconnect policy: exponential backoff with jitter, capped at 30 seconds.
class SseRetryPolicy {
  const SseRetryPolicy({
    this.base = const Duration(seconds: 1),
    this.factor = 2,
    this.max = const Duration(seconds: 30),
    this.jitterRatio = 0.2,
    math.Random? random,
  }) : _random = random;

  final Duration base;
  final double factor;
  final Duration max;
  final double jitterRatio;
  final math.Random? _random;

  /// Delay before retry [attempt] (0 — the first retry after a drop).
  Duration delayFor(int attempt) {
    final raw = base.inMilliseconds * math.pow(factor, attempt).toDouble();
    final capped = math.min(raw, max.inMilliseconds.toDouble());
    final jitter =
        (_random ?? math.Random()).nextDouble() * 2 * jitterRatio - jitterRatio;
    return Duration(milliseconds: math.max(0, (capped * (1 + jitter)).round()));
  }
}

/// Connection lifecycle of an SSE stream (for UI indicators).
enum SseConnectionStatus { connecting, connected, reconnecting, closed }

/// Opens a reconnecting SSE stream of JSON objects.
///
/// Contract: the returned stream emits one map per event whose `data` decodes
/// to a JSON object (other payloads are dropped). A dropped connection (EOF,
/// network error, 5xx) never kills the stream — the session reconnects with
/// exponential backoff (capped by [SseRetryPolicy.max]) and replays from
/// `Last-Event-ID`. Fatal: 4xx responses and [CertificateMismatch] (emitted as
/// stream errors, then the stream closes). The stream is single-subscription.
Stream<Map<String, dynamic>> openSseJsonStream(
  Uri uri, {
  required SseByteOpener open,
  Map<String, String> headers = const {},
  SseRetryPolicy retryPolicy = const SseRetryPolicy(),
  void Function(SseConnectionStatus status)? onStatus,
}) {
  final session = _SseJsonSession(uri, open, headers, retryPolicy, onStatus);
  return session.stream;
}

class _SseJsonSession {
  _SseJsonSession(
    this._uri,
    this._open,
    this._headers,
    this._retryPolicy,
    this._onStatus,
  );

  final Uri _uri;
  final SseByteOpener _open;
  final Map<String, String> _headers;
  final SseRetryPolicy _retryPolicy;
  final void Function(SseConnectionStatus status)? _onStatus;

  StreamController<Map<String, dynamic>>? _controller;
  int? _lastId;
  bool _stopped = false;
  bool _started = false;

  Stream<Map<String, dynamic>> get stream {
    _controller ??= StreamController<Map<String, dynamic>>(
      onListen: _start,
      onCancel: _stop,
    );
    return _controller!.stream;
  }

  void _start() {
    if (_started || _stopped) {
      return;
    }
    _started = true;
    unawaited(_run());
  }

  void _stop() {
    if (_stopped) {
      return;
    }
    _stopped = true;
    final controller = _controller;
    if (controller != null && !controller.isClosed) {
      controller.close();
    }
    _notify(SseConnectionStatus.closed);
  }

  Future<void> _run() async {
    var attempt = 0;
    _notify(SseConnectionStatus.connecting);
    while (!_stopped) {
      try {
        final bytes = await _open(_uri, headers: _requestHeaders());
        attempt = 0;
        if (_stopped) {
          return;
        }
        _notify(SseConnectionStatus.connected);
        final parser = SseParser();
        await for (final text
            in bytes.transform(const Utf8Decoder(allowMalformed: true))) {
          if (_stopped) {
            return;
          }
          for (final event in parser.addChunk(text)) {
            _emit(event);
          }
        }
        // EOF (server restart / stream cap) — silent reconnect below.
      } on CertificateMismatch catch (error) {
        _fail(error);
        return;
      } catch (error) {
        if (_isFatalHttp(error)) {
          _fail(error);
          return;
        }
        // 5xx and network errors are transient — retry.
      }
      if (_stopped) {
        return;
      }
      _notify(SseConnectionStatus.reconnecting);
      await Future<void>.delayed(_retryPolicy.delayFor(attempt++));
    }
  }

  Map<String, String> _requestHeaders() {
    final lastId = _lastId;
    return {
      ..._headers,
      if (lastId != null) 'Last-Event-ID': '$lastId',
    };
  }

  void _emit(SseEvent event) {
    final controller = _controller;
    if (_stopped || controller == null || controller.isClosed) {
      return;
    }
    _lastId = event.id ?? _lastId;
    final data = event.data;
    if (data != null) {
      controller.add(data);
    }
  }

  void _fail(Object error) {
    final controller = _controller;
    _stopped = true;
    if (controller != null && !controller.isClosed) {
      controller
        ..addError(error)
        ..close();
    }
    _notify(SseConnectionStatus.closed);
  }

  void _notify(SseConnectionStatus status) => _onStatus?.call(status);

  static bool _isFatalHttp(Object error) =>
      error is JhinHttpException && error.statusCode >= 400 && error.statusCode < 500;
}