import 'dart:async';

import 'package:http/http.dart' as http;

import 'net_error_stub.dart'
    if (dart.library.io) 'net_error_io.dart'
    if (dart.library.js_interop) 'net_error_web.dart'
    as platform;

/// true, если [error] — сетевой/транспортный отказ (сервер недоступен,
/// TLS-хендшоп не удался, timeout) — показывается как «Сервер недоступен».
///
/// [TlsPinMismatchException] сюда не попадает: его экран трактует отдельно
/// (жёсткая ошибка про MITM).
bool isNetworkError(Object error) =>
    error is http.ClientException ||
    error is TimeoutException ||
    platform.isPlatformNetworkError(error);
