import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Формат SHA-256-фингерпринта сертификата: 32 байта hex UPPERCASE парами через `:`,
/// ровно 95 символов (`^([0-9A-F]{2}:){31}[0-9A-F]{2}$`). Совпадает с форматом
/// `TLS fingerprint (SHA-256)` в логах backend'а (SHA-256 от DER-кодировки).
final RegExp fingerprintFormat = RegExp(r'^([0-9A-F]{2}:){31}[0-9A-F]{2}$');

/// true, если [value] — валидный фингерпринт в формате [fingerprintFormat].
bool isValidFingerprint(String value) => fingerprintFormat.hasMatch(value);

/// Форматирует сырые байты дайджеста (32 байта SHA-256) в строку-фингерпринт.
String formatFingerprint(List<int> digest) {
  final buffer = StringBuffer();
  for (var i = 0; i < digest.length; i++) {
    if (i > 0) {
      buffer.write(':');
    }
    buffer.write(digest[i].toRadixString(16).toUpperCase().padLeft(2, '0'));
  }
  return buffer.toString();
}

/// SHA-256-фингерпринт DER-кодировки сертификата.
///
/// SPIKE (Dart 3.13, `dart:io`): `X509Certificate` имеет геттер `der`
/// (`Uint8List get der`) — DER-байты доступны напрямую, PEM-парсинг не нужен:
/// ```dart
/// badCertificateCallback: (cert, host, port) =>
///     trustStore.verify(certFingerprint(cert.der));
/// ```
/// На web сертификат недоступен JS'у — функция используется только на IO-платформах.
String certFingerprint(Uint8List der) =>
    formatFingerprint(sha256.convert(der).bytes);

/// TOFU-хранилище пина TLS-сертификата сервера.
///
/// Состояния:
///  * не запинен — [verify] принимает любой peer (TOFU) и запоминает его
///    как [pendingFingerprint] (для показа пользователю в T28/T31);
///  * запинен — [verify] принимает только точное совпадение; несовпадение
///    → `false` и [rejectedFingerprint] (отказ, возможен MITM).
///
/// Пин живёт памяти; персистентность — через `TokenStorage.pinnedFingerprint`
/// (см. `JhinClient.pinCertificate`).
class TrustStore {
  TrustStore({String? pinnedFingerprint}) {
    if (pinnedFingerprint != null) {
      pin(pinnedFingerprint);
    }
  }

  String? _pinned;
  String? _pending;
  String? _rejected;

  /// Текущий пин или null (TOFU-режим).
  String? get pinnedFingerprint => _pinned;

  /// Последний неподтверждённый peer (TOFU до `pin()`), иначе null.
  String? get pendingFingerprint => _pending;

  /// Последний отклонённый из-за несовпадения с пином peer, иначе null.
  String? get rejectedFingerprint => _rejected;

  bool get isPinned => _pinned != null;

  /// Проверка peer-фингерпринта при рукопожатии (badCertificateCallback).
  ///
  /// true — соединение принимается; false — отклоняется (несовпадение с пином).
  bool verify(String fingerprint) {
    _rejected = null;
    final pinned = _pinned;
    if (pinned == null) {
      _pending = fingerprint;
      return true;
    }
    if (pinned == fingerprint) {
      return true;
    }
    _rejected = fingerprint;
    return false;
  }

  /// Пинит [fingerprint] (формат валидируется) и сбрасывает pending.
  void pin(String fingerprint) {
    if (!isValidFingerprint(fingerprint)) {
      throw ArgumentError.value(
          fingerprint, 'fingerprint', 'invalid fingerprint format');
    }
    _pinned = fingerprint;
    _pending = null;
    _rejected = null;
  }

  /// Снимает пин и всю историю (выход, смена сервера, отказ пользователя).
  void clear() {
    _pinned = null;
    _pending = null;
    _rejected = null;
  }
}

/// Отказ TLS-рукопожатия из-за несовпадения с пином: соединение не принимается,
/// возможен MITM. Фатальна для SSE-транспорта (не ретраится).
class TlsPinMismatchException implements Exception {
  const TlsPinMismatchException({this.fingerprint, this.pinnedFingerprint});

  /// Фингерпринт предъявленного (отклонённого) сертификата.
  final String? fingerprint;

  /// Ожидаемый пин.
  final String? pinnedFingerprint;

  @override
  String toString() =>
      'TlsPinMismatchException: peer fingerprint $fingerprint does not match '
      'pinned $pinnedFingerprint — connection rejected (possible MITM)';
}
