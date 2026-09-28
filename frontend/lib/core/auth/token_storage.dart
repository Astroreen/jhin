import 'package:flutter/foundation.dart';

import 'prefs_token_storage.dart';
import 'secure_token_storage.dart';

/// Хранилище секретов и настроек подключения устройства.
///
/// Ключи неймспейснуты префиксом `jhin.`/`jhin_`. Значения — строки; секреты
/// (device-токен) не логируются. На web персистентность — `shared_preferences`
/// (браузер не отдаёт сертификат, secure-storage там бессмыслен), на
/// mobile/desktop — `flutter_secure_storage`.
abstract interface class TokenStorage {
  /// Device-токен (Bearer) или null, если устройство не заenroll'ено.
  Future<String?> readToken();

  Future<void> writeToken(String token);

  Future<void> clearToken();

  /// URL hub'а (`https://host:port`) или null.
  Future<String?> readServerUrl();

  Future<void> writeServerUrl(String serverUrl);

  Future<void> clearServerUrl();

  /// Запиненный SHA-256-фингерпринт TLS-сертификата (формат из `tls_trust`).
  Future<String?> readPinnedFingerprint();

  Future<void> writePinnedFingerprint(String fingerprint);

  Future<void> clearPinnedFingerprint();

  /// Полная очистка (выход из аккаунта/смена сервера).
  Future<void> clearAll();
}

/// Платформенный выбор хранилища: web → prefs, остальное → secure storage.
TokenStorage createTokenStorage() =>
    kIsWeb ? PrefsTokenStorage() : SecureTokenStorage();
