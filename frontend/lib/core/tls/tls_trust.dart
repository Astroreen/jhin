import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// SHA-256 certificate fingerprint format: 32 bytes hex UPPERCASE in colon
/// pairs, exactly 95 characters (`^([0-9A-F]{2}:){31}[0-9A-F]{2}$`). Matches
/// the `TLS fingerprint (SHA-256)` lines in backend logs (SHA-256 over DER).
final RegExp fingerprintFormat = RegExp(r'^([0-9A-F]{2}:){31}[0-9A-F]{2}$');

/// True when [value] is a valid fingerprint in [fingerprintFormat].
bool isValidFingerprint(String value) => fingerprintFormat.hasMatch(value);

/// Formats raw digest bytes (32 bytes of SHA-256) as a colon fingerprint.
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

/// SHA-256 fingerprint of a certificate's DER encoding.
///
/// IO platforms read DER straight off `dart:io` `X509Certificate.der`; web
/// never sees the peer certificate, so this helper is IO-only in practice.
String certFingerprint(Uint8List der) =>
    formatFingerprint(sha256.convert(der).bytes);

/// TOFU store for the server TLS certificate fingerprint.
///
/// States:
///  * unpinned — [verify] accepts any peer (TOFU) and remembers it as
///    [pendingFingerprint] until the caller pins it;
///  * pinned — [verify] accepts an exact match only; a mismatch returns
///    `false` and records [rejectedFingerprint].
class TrustStore {
  TrustStore({String? pinnedFingerprint}) {
    if (pinnedFingerprint != null) {
      pin(pinnedFingerprint);
    }
  }

  String? _pinned;
  String? _pending;
  String? _rejected;

  /// The pinned fingerprint, or null in TOFU mode.
  String? get pinnedFingerprint => _pinned;

  /// The last unpinned peer seen (TOFU before `pin()`), else null.
  String? get pendingFingerprint => _pending;

  /// The last peer rejected for mismatching the pin, else null.
  String? get rejectedFingerprint => _rejected;

  bool get isPinned => _pinned != null;

  /// Checks a peer fingerprint during the TLS handshake.
  ///
  /// Returns true when the connection may proceed; false when the peer
  /// mismatches the pin (the handshake must fail).
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

  /// Pins [fingerprint] (format validated) and clears pending/rejected state.
  void pin(String fingerprint) {
    if (!isValidFingerprint(fingerprint)) {
      throw ArgumentError.value(
          fingerprint, 'fingerprint', 'invalid fingerprint format');
    }
    _pinned = fingerprint;
    _pending = null;
    _rejected = null;
  }

  /// Drops the pin and all history (sign-out, server change, user refusal).
  void clear() {
    _pinned = null;
    _pending = null;
    _rejected = null;
  }
}

/// Blocking TLS failure: the peer certificate does not match the pinned
/// fingerprint (possible MITM). The UI must surface it as a blocking error
/// with a "trust new certificate" confirmation before any retry.
class CertificateMismatch implements Exception {
  const CertificateMismatch({this.presented, this.pinned});

  /// Fingerprint of the rejected peer certificate, when known.
  final String? presented;

  /// The expected pinned fingerprint, when one is set.
  final String? pinned;

  @override
  String toString() =>
      'CertificateMismatch: peer fingerprint $presented does not match '
      'pinned $pinned — connection rejected (possible MITM)';
}