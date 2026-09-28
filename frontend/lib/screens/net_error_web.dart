/// Web: отказы браузерного fetch'а приходят как `http.ClientException` —
/// обрабатывается общим кодом в `net_error.dart`.
bool isPlatformNetworkError(Object error) => false;
