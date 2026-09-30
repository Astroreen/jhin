/// Per-screen local state (§8.7): field id to current value, seeded from
/// node `value` props and mutated by `setState` and input widgets.
///
/// Also carries the inline validation errors shown under inputs (§8.4).
class UiState {
  final Map<String, Object?> _values = {};
  final Map<String, String> _errors = {};

  /// Current value of [id], or null when unset.
  Object? operator [](String id) => _values[id];

  /// All values (unmodifiable snapshot).
  Map<String, Object?> get values => Map.unmodifiable(_values);

  /// Sets [id] to [value] and clears any validation error on it.
  void setValue(String id, Object? value) {
    _values[id] = value;
    _errors.remove(id);
  }

  /// Seeds [id] to [value] when it has no value yet.
  void seedValue(String id, Object? value) {
    _values.putIfAbsent(id, () => value);
  }

  /// The inline validation error of [id], if any.
  String? errorFor(String id) => _errors[id];

  /// Sets (or clears, when [message] is null) the inline error of [id].
  void setError(String id, String? message) {
    if (message == null) {
      _errors.remove(id);
    } else {
      _errors[id] = message;
    }
  }
}
