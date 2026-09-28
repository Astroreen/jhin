import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/core/tls/tls_trust.dart';

/// Известный тестовый вектор SHA-256("abc") (NIST), формат UPPERCASE pairs `:`.
/// Значение внедрено сборочным скриптом из hashlib — не транскрибируется вручную.
const expectedSha256OfAbc = 'BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD';

String pairs(List<int> bytes) => formatFingerprint(bytes);

void main() {
  group('формат фингерпринта', () {
    test('formatFingerprint: UPPERCASE hex парами через :, длина 95', () {
      final fingerprint = pairs(List.generate(32, (i) => i));
      expect(fingerprint, hasLength(95));
      expect(isValidFingerprint(fingerprint), isTrue);
      expect(fingerprintFormat.hasMatch(fingerprint), isTrue);
    });

    test('certFingerprint == formatFingerprint(sha256(der))', () {
      final der = Uint8List.fromList('abc'.codeUnits);
      expect(certFingerprint(der), pairs(sha256.convert(der).bytes));
    });

    test('certFingerprint: SHA-256 известного вектора "abc"', () {
      final fingerprint = certFingerprint(Uint8List.fromList('abc'.codeUnits));
      expect(fingerprint, expectedSha256OfAbc);
      expect(isValidFingerprint(fingerprint), isTrue);
    });

    test('isValidFingerprint отклоняет кривые строки', () {
      final lowerHex = List.generate(32, (_) => 'aa').join(':');
      final notHex = List.generate(32, (_) => 'zz').join(':');
      final tooShort = List.generate(31, (_) => 'AA').join(':');
      const noColons = 'ba7816bf8f01cfea414140de5dae2223'
          'b00361a396177a9cb410ff61f20015ad';
      expect(isValidFingerprint(''), isFalse);
      expect(isValidFingerprint('abc'), isFalse);
      expect(isValidFingerprint('aa:bb'), isFalse);
      expect(isValidFingerprint(lowerHex), isFalse);
      expect(isValidFingerprint(notHex), isFalse);
      expect(isValidFingerprint(tooShort), isFalse);
      expect(isValidFingerprint(noColons), isFalse);
    });
  });

  group('TrustStore', () {
    test('не запинен: TOFU принимает peer и помнит pending', () {
      final trust = TrustStore();
      expect(trust.isPinned, isFalse);
      final first = pairs(List.generate(32, (i) => i));
      expect(trust.verify(first), isTrue);
      expect(trust.pendingFingerprint, first);
      expect(trust.rejectedFingerprint, isNull);
    });

    test('pin/verify: совпадение принимается', () {
      final trust = TrustStore();
      final cert = pairs(List.generate(32, (i) => i));
      trust.pin(cert);
      expect(trust.isPinned, isTrue);
      expect(trust.pinnedFingerprint, cert);
      expect(trust.pendingFingerprint, isNull);
      expect(trust.verify(cert), isTrue);
      expect(trust.rejectedFingerprint, isNull);
    });

    test('смена серта при запиненном пине → reject (возможен MITM)', () {
      final trust = TrustStore();
      final original = pairs(List.generate(32, (i) => i));
      final other = pairs(List.generate(32, (i) => 255 - i));
      trust.pin(original);
      expect(trust.verify(other), isFalse);
      expect(trust.rejectedFingerprint, other);
      expect(trust.verify(original), isTrue);
      expect(trust.rejectedFingerprint, isNull);
    });

    test('pin кривого формата кидает ArgumentError', () {
      final trust = TrustStore();
      expect(() => trust.pin('not-a-fingerprint'), throwsArgumentError);
      expect(trust.isPinned, isFalse);
    });

    test('конструктор с пином валидирует формат', () {
      final fingerprint = pairs(List.generate(32, (i) => i + 7));
      final trust = TrustStore(pinnedFingerprint: fingerprint);
      expect(trust.isPinned, isTrue);
      expect(() => TrustStore(pinnedFingerprint: 'bad'), throwsArgumentError);
    });

    test('clear сбрасывает пин и историю', () {
      final trust = TrustStore();
      trust.pin(pairs(List.generate(32, (i) => i)));
      trust.clear();
      expect(trust.isPinned, isFalse);
      expect(trust.pinnedFingerprint, isNull);
      expect(trust.pendingFingerprint, isNull);
      expect(trust.rejectedFingerprint, isNull);
    });
  });
}
