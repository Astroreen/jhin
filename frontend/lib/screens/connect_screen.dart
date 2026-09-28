import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/api/api_client.dart';
import '../core/auth/token_storage.dart';
import '../core/jhin_client.dart';
import '../core/tls/tls_trust.dart';
import 'net_error.dart';

/// Колбэк успешного подключения: живой [JhinClient] + результат enroll.
/// Точка расширения вместо готовых экранов сессий (T29+).
typedef ConnectCallback = void Function(JhinClient client, EnrollResult result);

/// Фабрика [JhinClient] под введённый URL — DI-точка для тестов
/// (подмена httpClient/storage/trustStore).
typedef ConnectClientFactory = Future<JhinClient> Function(Uri serverUrl);

/// Жёсткая ошибка несовпадения запиненного фингерпринта (возможен MITM).
const String tlsPinMismatchMessage =
    'Fingerprint не совпадает с сохранённым! Возможен MITM.';

/// Нормализует введённый URL сервера: добавляет `https://`, если схема не
/// указана; срезает хвостовые `/`. null — невалидно (inline-ошибка).
String? normalizeServerUrl(String raw) {
  var text = raw.trim();
  if (text.isEmpty) {
    return null;
  }
  if (!text.contains('://')) {
    text = 'https://$text';
  }
  final uri = Uri.tryParse(text);
  if (uri == null) {
    return null;
  }
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    return null;
  }
  if (uri.host.isEmpty) {
    return null;
  }
  var out = uri.toString();
  while (out.endsWith('/')) {
    out = out.substring(0, out.length - 1);
  }
  return out;
}

/// Вырезает пробелы/дефисы из enrollment-кода и приводит к верхнему регистру
/// (paste-friendly: `xxxx-xxxx ...` → `XXXXXXXX...`).
String normalizeEnrollmentCode(String raw) =>
    raw.replaceAll(RegExp(r'[\s-]'), '').toUpperCase();

/// Формат enrollment-кода: 26 символов Base32 (`A-Z2-7`), см. backend
/// `EnrollmentService` (128 бит энтропии → Base32 без паддинга).
final RegExp enrollmentCodeFormat = RegExp(r'^[A-Z2-7]{26}$');

/// true, если [code] — валидный enrollment-код в формате [enrollmentCodeFormat].
bool isValidEnrollmentCode(String code) => enrollmentCodeFormat.hasMatch(code);

/// Имя устройства по умолчанию: «Flutter Client (<платформа>)».
String defaultDeviceName() {
  if (kIsWeb) {
    return 'Flutter Client (Web)';
  }
  final platform = switch (defaultTargetPlatform) {
    TargetPlatform.android => 'Android',
    TargetPlatform.iOS => 'iOS',
    TargetPlatform.fuchsia => 'Fuchsia',
    TargetPlatform.linux => 'Linux',
    TargetPlatform.macOS => 'macOS',
    TargetPlatform.windows => 'Windows',
  };
  return 'Flutter Client ($platform)';
}

/// Человекочитаемый текст ошибки API (`{"error":"<code>"}` из спеки enroll).
String describeApiError(ApiClientException error) => switch (error.error) {
  'invalid_code' => 'Код неверен',
  'code_used' => 'Код уже использован',
  'code_expired' => 'Код истёк',
  'bad_request' => 'Некорректный запрос',
  'rate_limited' => 'Слишком много попыток, подождите',
  _ when error.statusCode == 429 => 'Слишком много попыток, подождите',
  _ => 'Ошибка сервера (HTTP ${error.statusCode})',
};

/// Человекочитаемый текст любой ошибки connect-flow.
String describeError(Object error) {
  if (error is TlsPinMismatchException) {
    return tlsPinMismatchMessage;
  }
  if (error is ApiClientException) {
    return describeApiError(error);
  }
  if (isNetworkError(error)) {
    return 'Сервер недоступен';
  }
  return 'Неизвестная ошибка';
}

/// Экран подключения к hub'у: server URL + enrollment code + device name.
///
/// Flow (TOFU):
///  1. Connect → нормализация/валидация → сборка [JhinClient] под этот URL.
///  2. TLS-контакт (`GET /health`): на IO первый самоподписанный сертификат
///     даёт `trustStore.pendingFingerprint` → диалог Accept/Cancel; Accept →
///     `pinCertificate` → продолжение, Cancel → назад к форме. Несовпадение с
///     уже запиненным ([TlsPinMismatchException]) → жёсткая ошибка про MITM,
///     без «принять всё равно».
///  3. Web: fingerprint JS'у недоступен (T27) — диалог пропускается, показана
///     пометка «TLS проверяется браузером» ([browserTlsNote]).
///  4. `POST /enroll` → device-токен + аккаунт в [TokenStorage] →
///     [onConnected] (экраны сессий — T29, здесь колбэк/роутинг).
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({
    super.key,
    required this.onConnected,
    this.clientFactory,
    this.initialServerUrl,
    this.browserTlsNote = kIsWeb,
  });

  /// Вызывается после успешного enroll.
  final ConnectCallback onConnected;

  /// DI-точка: сборка [JhinClient] под введённый URL; тесты подменяют
  /// httpClient/storage. Дефолт — реальный [JhinClient.create].
  final ConnectClientFactory? clientFactory;

  /// Предзаполненный URL сервера (если уже известен).
  final String? initialServerUrl;

  /// Пометка «TLS проверяется браузером», когда fingerprint недоступен (web).
  final bool browserTlsNote;

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  late final TextEditingController _urlController;
  late final TextEditingController _codeController;
  late final TextEditingController _deviceController;

  bool _busy = false;
  bool _handedOff = false;
  String? _urlError;
  String? _codeError;
  String? _deviceError;
  String? _message;
  JhinClient? _client;

  @override
  void initState() {
    super.initState();
    _urlController = TextEditingController(text: widget.initialServerUrl);
    _codeController = TextEditingController();
    _deviceController = TextEditingController(text: defaultDeviceName());
  }

  @override
  void dispose() {
    _urlController.dispose();
    _codeController.dispose();
    _deviceController.dispose();
    if (!_handedOff) {
      _client?.close();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Jhin')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  key: const Key('field-server-url'),
                  controller: _urlController,
                  enabled: !_busy,
                  keyboardType: TextInputType.url,
                  decoration: InputDecoration(
                    labelText: 'Server URL',
                    hintText: 'https://host:8443',
                    errorText: _urlError,
                  ),
                ),
                const SizedBox(height: 16),
                TextFormField(
                  key: const Key('field-enroll-code'),
                  controller: _codeController,
                  enabled: !_busy,
                  decoration: InputDecoration(
                    labelText: 'Enrollment code',
                    errorText: _codeError,
                  ),
                ),
                const SizedBox(height: 16),
                TextFormField(
                  key: const Key('field-device-name'),
                  controller: _deviceController,
                  enabled: !_busy,
                  decoration: InputDecoration(
                    labelText: 'Device name',
                    errorText: _deviceError,
                  ),
                ),
                const SizedBox(height: 24),
                if (_message != null) ...[
                  Text(
                    _message!,
                    key: const Key('connect-error'),
                    style: TextStyle(color: colorScheme.error),
                  ),
                  const SizedBox(height: 16),
                ],
                FilledButton(
                  key: const Key('btn-connect'),
                  onPressed: _busy ? null : _submit,
                  child: _busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Connect'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    final normalizedUrl = normalizeServerUrl(_urlController.text);
    final code = normalizeEnrollmentCode(_codeController.text);
    final deviceName = _deviceController.text.trim();
    setState(() {
      _urlError = _urlController.text.trim().isEmpty
          ? 'Укажите URL сервера'
          : (normalizedUrl == null ? 'Некорректный URL' : null);
      _codeError = isValidEnrollmentCode(code) ? null : 'похоже, не тот формат';
      _deviceError = deviceName.isEmpty ? 'Укажите имя устройства' : null;
      _message = null;
    });
    if (_urlError != null || _codeError != null || _deviceError != null) {
      return;
    }

    setState(() => _busy = true);
    try {
      final outcome = await _connect(
        Uri.parse(normalizedUrl!),
        code: code,
        deviceName: deviceName,
      );
      if (!mounted) {
        return;
      }
      setState(() => _busy = false);
      if (outcome != null) {
        widget.onConnected(outcome.$1, outcome.$2);
      }
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _busy = false;
        _message = describeError(error);
      });
    }
  }

  /// TOFU + enroll. null — пользователь отклонил фингерпринт (или виджет
  /// размонтирован) — без ошибки, форма остаётся.
  Future<(JhinClient, EnrollResult)?> _connect(
    Uri serverUrl, {
    required String code,
    required String deviceName,
  }) async {
    _client?.close();
    final factory = widget.clientFactory ?? _createDefaultClient;
    final client = await factory(serverUrl);
    _client = client;
    final fingerprint = await _probeTls(client);
    if (fingerprint != null) {
      if (!mounted) {
        return null;
      }
      final accept = await _confirmFingerprint(fingerprint);
      if (!mounted || !accept) {
        return null;
      }
      await client.pinCertificate(fingerprint);
    } else if (widget.browserTlsNote) {
      if (!mounted) {
        return null;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('TLS проверяется браузером')),
      );
    }
    final result = await client.api.enroll(code: code, deviceName: deviceName);
    client.api.token = result.deviceToken;
    await client.storage.writeToken(result.deviceToken);
    await client.storage.writeServerUrl(serverUrl.toString());
    await client.storage.writeAccount(
      StoredAccount(
        accountId: result.accountId,
        accountName: result.accountName,
      ),
    );
    _handedOff = true;
    return (client, result);
  }

  static Future<JhinClient> _createDefaultClient(Uri serverUrl) =>
      JhinClient.create(baseUrl: serverUrl);

  /// TLS-контакт (анонимный `GET /health`): рукопожатие заполняет
  /// `trustStore.pendingFingerprint` (IO, первый контакт) либо оставляет его
  /// null (web / пин совпал / доверенный CA) — тогда диалог не нужен.
  Future<String?> _probeTls(JhinClient client) async {
    await client.api.health();
    return client.trustStore.pendingFingerprint;
  }

  Future<bool> _confirmFingerprint(String fingerprint) async {
    final accepted = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Text('Сертификат самоподписанный'),
        content: Text(
          'SHA-256 fingerprint: $fingerprint\nПринять и запомнить?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Accept'),
          ),
        ],
      ),
    );
    return accepted ?? false;
  }
}
