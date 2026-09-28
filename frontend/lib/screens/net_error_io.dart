import 'dart:io';

/// IO (Linux/Android/desktop): сетевые отказы `dart:io` —
/// `SocketException`/`HandshakeException`/`HttpException` и т.п.
bool isPlatformNetworkError(Object error) =>
    error is IOException || error is OSError;
