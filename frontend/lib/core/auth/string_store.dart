/// Minimal async string key-value backend.
///
/// [AppStorage] is built on two of these: a prefs backend (profiles) and a
/// secure backend (device tokens). Tests inject [InMemoryStringStore].
abstract interface class StringStore {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}

/// In-memory [StringStore] for tests and ephemeral use.
class InMemoryStringStore implements StringStore {
  final Map<String, String> _values = {};

  /// Snapshot of the stored values (for assertions in tests).
  Map<String, String> get values => Map.unmodifiable(_values);

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
  }
}