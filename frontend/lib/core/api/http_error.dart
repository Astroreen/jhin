import 'dart:convert';

/// Transport-level HTTP failure: the server answered with a non-2xx status.
///
/// Carries the raw [body] alongside the [statusCode] so callers (and QA
/// fixtures) can surface both; [errorCode] is the `error` field of a
/// `{"error":"<code>"}` body when present.
class JhinHttpException implements Exception {
  const JhinHttpException({
    required this.statusCode,
    required this.body,
    this.errorCode,
  });

  /// Builds the exception from a non-2xx response.
  factory JhinHttpException.fromResponse(int statusCode, String body) =>
      JhinHttpException(
        statusCode: statusCode,
        body: body,
        errorCode: _errorCode(body),
      );

  final int statusCode;
  final String body;
  final String? errorCode;

  @override
  String toString() =>
      'JhinHttpException($statusCode, error: $errorCode, body: $body)';

  static String? _errorCode(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic> && decoded['error'] is String) {
        return decoded['error'] as String;
      }
    } on FormatException {
      // Body is not JSON — no error code.
    }
    return null;
  }
}