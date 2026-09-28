import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import '../api/api_client.dart';
import '../tls/tls_trust.dart';
import 'sse_parser.dart';
import 'sse_transport_stub.dart'
    if (dart.library.io) 'sse_io.dart'
    if (dart.library.js_interop) 'sse_web.dart' as platform;

export 'sse_parser.dart' show SseEvent, SseParser;

/// Статус соединения SSE-транспорта (для UI-индикации T28/T29).
enum SseTransportStatus { connecting, connected, reconnecting, closed }

typedef SseStatusCallback = void Function(SseTransportStatus status);

/// Политика повторных подключений: экспоненциальный backoff с джиттером.
///
/// Дефолт (спека T27): база 1с, factor 2, max 30с, джиттер ±20%.
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

  /// Задержка перед попыткой [attempt] (0 — первая повторная после обрыва).
  Duration delayFor(int attempt) {
    final raw = base.inMilliseconds * math.pow(factor, attempt).toDouble();
    final capped = math.min(raw, max.inMilliseconds.toDouble());
    final jitter =
        (_random ?? math.Random()).nextDouble() * 2 * jitterRatio - jitterRatio;
    return Duration(milliseconds: math.max(0, (capped * (1 + jitter)).round()));
  }
}

/// Открывает байтовой поток SSE-ответа (`Stream<List<int>>`).
///
/// Non-2xx (4xx — фатально; 5xx — ретраится транспортом) и отказ пина TLS
/// кидаются как [ApiClientException]/[TlsPinMismatchException]; сетевые ошибки
/// — как есть (транспорт ретраит).
typedef SseByteOpener = Future<Stream<List<int>>> Function(
  Uri uri, {
  String? token,
});

/// Транспорт SSE-потока событий сессии (`GET /sessions/{id}/events`).
///
/// Контракт: [connect] возвращает поток событий; одиночная сетевая ошибка или
/// cap-обрыв (15 мин) НЕ убивают поток — автоматический реконнект с
/// `fromSeq = lastId + 1` (без дыр и дублей) и уведомлением через
/// `SseStatusCallback`. Фатальны только 4xx и несовпадение TLS-пина.
abstract interface class SseTransport {
  /// Подключается к [url] (`.../sessions/{id}/events`); [fromSeq] — seq >= N
  /// (INCLUSIVE), null — вся история. [token] — device-токен (Bearer).
  Stream<SseEvent> connect(String url, {String? token, int? fromSeq});

  /// seq последнего доставленного события (для внешнего resume после рестарта).
  int? get lastEventId;

  /// Останавливает все соединения и ретраи; потоки закрываются.
  void close();
}

/// Создаёт SSE-транспорт платформы.
///
/// IO: `dart:io HttpClient` с TOFU-pinning через [trustStore]; web: fetch +
/// ReadableStream (`package:web`), пин невозможен (см. `api_client_web.dart`).
SseTransport createSseTransport({
  TrustStore? trustStore,
  SseStatusCallback? onStatus,
  SseRetryPolicy? retryPolicy,
}) =>
    platform.createSseTransport(
      trustStore: trustStore,
      onStatus: onStatus,
      retryPolicy: retryPolicy,
    );

/// Реализация с автоматическим реконнектом поверх [SseByteOpener].
///
/// Ошибка открытия: [ApiClientException] с 4xx и [TlsPinMismatchException] —
/// фатальны (addError + закрытие потока); 5xx и сетевые — retry с backoff.
class ReconnectingSseTransport implements SseTransport {
  ReconnectingSseTransport(
    this._open, {
    SseStatusCallback? onStatus,
    SseRetryPolicy? retryPolicy,
    void Function()? onDispose,
  })  : _onStatus = onStatus,
        _retryPolicy = retryPolicy ?? const SseRetryPolicy(),
        _onDispose = onDispose;

  final SseByteOpener _open;
  final SseStatusCallback? _onStatus;
  final SseRetryPolicy _retryPolicy;
  final void Function()? _onDispose;

  final Set<_SseSession> _sessions = {};
  bool _closed = false;
  int? _lastEventId;

  @override
  int? get lastEventId => _lastEventId;

  @override
  Stream<SseEvent> connect(String url, {String? token, int? fromSeq}) {
    if (_closed) {
      throw StateError('SseTransport is closed');
    }
    final session = _SseSession(this, url, token, fromSeq);
    _sessions.add(session);
    return session.stream;
  }

  @override
  void close() {
    if (_closed) {
      return;
    }
    _closed = true;
    final sessions = List.of(_sessions);
    _sessions.clear();
    for (final session in sessions) {
      session.stop(notify: false);
    }
    _onDispose?.call();
    _notify(SseTransportStatus.closed);
  }

  void _notify(SseTransportStatus status) => _onStatus?.call(status);

  void _track(int? id) {
    if (id != null) {
      _lastEventId = id;
    }
  }

  void _retire(_SseSession session) {
    _sessions.remove(session);
  }
}

class _SseSession {
  _SseSession(this._transport, this._url, this._token, this._initialFromSeq);

  final ReconnectingSseTransport _transport;
  final String _url;
  final String? _token;
  final int? _initialFromSeq;

  StreamController<SseEvent>? _controller;
  int? _lastId;
  bool _stopped = false;
  bool _started = false;

  Stream<SseEvent> get stream {
    _controller ??= StreamController<SseEvent>(
      onListen: _start,
      onCancel: () => stop(notify: false),
    );
    return _controller!.stream;
  }

  void stop({required bool notify}) {
    if (_stopped) {
      return;
    }
    _stopped = true;
    final controller = _controller;
    _transport._retire(this);
    if (controller != null && !controller.isClosed) {
      controller.close();
    }
    if (notify) {
      _transport._notify(SseTransportStatus.closed);
    }
  }

  void _start() {
    if (_started || _stopped) {
      return;
    }
    _started = true;
    unawaited(_run());
  }

  Future<void> _run() async {
    var attempt = 0;
    _transport._notify(SseTransportStatus.connecting);
    while (!_stopped) {
      try {
        final from = _lastId != null ? _lastId! + 1 : _initialFromSeq;
        final bytes = await _transport._open(_buildUri(from), token: _token);
        attempt = 0;
        if (_stopped) {
          return;
        }
        _transport._notify(SseTransportStatus.connected);
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
        // EOF (cap 15 мин / рестарт) — тихий реконнект с fromSeq = lastId + 1.
      } on ApiClientException catch (error) {
        if (error.statusCode >= 400 && error.statusCode < 500) {
          _fail(error);
          return;
        }
        // 5xx — ретраим как временный сбой.
      } on TlsPinMismatchException catch (error) {
        _fail(error);
        return;
      } catch (_) {
        // Сетевая ошибка — ретраим.
      }
      if (_stopped) {
        return;
      }
      _transport._notify(SseTransportStatus.reconnecting);
      await Future<void>.delayed(_transport._retryPolicy.delayFor(attempt++));
    }
  }

  void _emit(SseEvent event) {
    final controller = _controller;
    if (_stopped || controller == null || controller.isClosed) {
      return;
    }
    _lastId = event.id ?? _lastId;
    _transport._track(event.id);
    controller.add(event);
  }

  void _fail(Object error) {
    final controller = _controller;
    _stopped = true;
    _transport._retire(this);
    if (controller != null && !controller.isClosed) {
      controller
        ..addError(error)
        ..close();
    }
    _transport._notify(SseTransportStatus.closed);
  }

  Uri _buildUri(int? fromSeq) {
    final base = Uri.parse(_url);
    if (fromSeq == null) {
      return base;
    }
    final query = Map<String, String>.from(base.queryParameters);
    query['fromSeq'] = '$fromSeq';
    return base.replace(queryParameters: query);
  }
}
