import 'package:flutter/foundation.dart';

/// Observable map of boolean command contexts — the client side of the
/// keymap `when` expressions (docs/sdui.md §1).
///
/// The nine contexts are fixed: `composerFocus`, `composerDraft`,
/// `turnRunning`, `editableFocus`, `isWeb`, `isDesktop`, `sidebarFocus`,
/// `paletteOpen`, `modalOpen`. Unknown names read as `false` and are ignored
/// on write — a typo must never break a keymap rule or throw.
///
/// [evaluate] understands the `when` expression grammar that docs/sdui.md §7
/// defines for `when` — bare context names, `!`, `&&`, `||` and parentheses
/// (§7 also lists comparisons and literals for the node `when` prop; those
/// have no meaning over boolean command contexts and degrade to `false`
/// here). Unknown names evaluate to `false`; any parse failure degrades to
/// `false`. Nothing in this class ever throws.
class WhenContext extends ChangeNotifier {
  /// Creates a context map with every context `false`, except the platform
  /// facts `isWeb` / `isDesktop` which default to the current platform when
  /// not given explicitly (injectable for tests).
  WhenContext({bool? isWeb, bool? isDesktop}) {
    _values['isWeb'] = isWeb ?? kIsWeb;
    _values['isDesktop'] = isDesktop ?? (!kIsWeb && _isDesktopPlatform);
  }

  /// The fixed context vocabulary.
  static const List<String> contextNames = <String>[
    'composerFocus',
    'composerDraft',
    'turnRunning',
    'editableFocus',
    'isWeb',
    'isDesktop',
    'sidebarFocus',
    'paletteOpen',
    'modalOpen',
  ];

  static bool get _isDesktopPlatform => switch (defaultTargetPlatform) {
        TargetPlatform.macOS ||
        TargetPlatform.windows ||
        TargetPlatform.linux =>
          true,
        _ => false,
      };

  final Map<String, bool> _values = <String, bool>{
    for (final name in contextNames) name: false,
  };

  /// The current value of one context; unknown names read as `false`.
  bool value(String name) => _values[name] ?? false;

  /// Sets one context; unknown names are ignored. Notifies listeners only
  /// when the value actually changes.
  void set(String name, bool newValue) {
    if (!_values.containsKey(name)) return;
    if (_values[name] == newValue) return;
    _values[name] = newValue;
    notifyListeners();
  }

  bool get composerFocus => value('composerFocus');
  set composerFocus(bool v) => set('composerFocus', v);

  bool get composerDraft => value('composerDraft');
  set composerDraft(bool v) => set('composerDraft', v);

  bool get turnRunning => value('turnRunning');
  set turnRunning(bool v) => set('turnRunning', v);

  bool get editableFocus => value('editableFocus');
  set editableFocus(bool v) => set('editableFocus', v);

  bool get isWeb => value('isWeb');
  set isWeb(bool v) => set('isWeb', v);

  bool get isDesktop => value('isDesktop');
  set isDesktop(bool v) => set('isDesktop', v);

  bool get sidebarFocus => value('sidebarFocus');
  set sidebarFocus(bool v) => set('sidebarFocus', v);

  bool get paletteOpen => value('paletteOpen');
  set paletteOpen(bool v) => set('paletteOpen', v);

  bool get modalOpen => value('modalOpen');
  set modalOpen(bool v) => set('modalOpen', v);

  /// Evaluates a keymap `when` expression against this context. Never
  /// throws. A `null` expression has no gate and evaluates `true`; every
  /// unknown name or parse failure evaluates `false`.
  bool evaluate(String? expression) {
    if (expression == null) return true;
    try {
      return _WhenExpression(expression, this).evaluate();
    } catch (_) {
      return false;
    }
  }
}

/// Recursive-descent evaluator for the §7 `when` subset over boolean
/// contexts: `name`, `!`, `&&`, `||`, parentheses. Unknown names are `false`;
/// any syntax error fails the whole expression to `false`.
class _WhenExpression {
  _WhenExpression(this.source, this.context);

  final String source;
  final WhenContext context;
  int _pos = 0;
  bool _failed = false;

  bool evaluate() {
    final result = _or();
    _skipSpace();
    if (_pos != source.length) return false;
    return _failed ? false : result;
  }

  bool _or() {
    var left = _and();
    while (_match('||')) {
      final right = _and();
      left = left || right;
    }
    return left;
  }

  bool _and() {
    var left = _unary();
    while (_match('&&')) {
      final right = _unary();
      left = left && right;
    }
    return left;
  }

  bool _unary() {
    if (_match('!')) return !_unary();
    return _primary();
  }

  bool _primary() {
    if (_match('(')) {
      final value = _or();
      if (!_match(')')) _failed = true;
      return value;
    }
    final name = _name();
    if (name == null) {
      _failed = true;
      return false;
    }
    return context.value(name);
  }

  String? _name() {
    _skipSpace();
    final start = _pos;
    while (_pos < source.length && _isNameChar(source[_pos], start == _pos)) {
      _pos++;
    }
    if (_pos == start) return null;
    return source.substring(start, _pos);
  }

  bool _isNameChar(String char, bool first) {
    final isLetter = char == '_' ||
        (char.codeUnitAt(0) >= 0x41 && char.codeUnitAt(0) <= 0x5A) ||
        (char.codeUnitAt(0) >= 0x61 && char.codeUnitAt(0) <= 0x7A);
    if (first) return isLetter;
    return isLetter || (char.codeUnitAt(0) >= 0x30 && char.codeUnitAt(0) <= 0x39);
  }

  bool _match(String token) {
    _skipSpace();
    if (source.length - _pos < token.length) return false;
    if (source.substring(_pos, _pos + token.length) != token) return false;
    _pos += token.length;
    return true;
  }

  void _skipSpace() {
    while (_pos < source.length && source[_pos] == ' ') {
      _pos++;
    }
  }
}
