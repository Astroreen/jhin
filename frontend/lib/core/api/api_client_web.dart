import 'package:http/http.dart' as http;

import '../tls/tls_trust.dart';

/// Web-клиент: обычный browser client (`XMLHttpRequest`/fetch под капотом).
///
/// App-level TOFU-pinning на web невозможен: браузер не отдаёт JS'у сертификат
/// соединения. Пользователь принимает предупреждение самоподписанного
/// сертификата один раз на уровне браузера; [trustStore] игнорируется.
http.Client createPlatformHttpClient({TrustStore? trustStore}) =>
    http.Client();
