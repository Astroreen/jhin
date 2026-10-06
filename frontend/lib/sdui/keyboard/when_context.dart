import 'package:flutter/foundation.dart';

/// Observable map of boolean command contexts — the client side of the
/// keymap `when` expressions (docs/sdui.md §1, §4).
///
/// The upstream t3code `ShortcutMatchContext`
/// (`apps/web/src/keybindings.ts:24-34`, commit 37de6cb) carries
/// `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, `isWeb`,
/// `isDesktop` and `editableFocus`; Jhin adds the composer/thread contexts
/// (`composerFocus`, `composerDraft`, `turnRunning`) and the palette/sidebar
/// contexts (`sidebarFocus`, `paletteOpen`, `modalOpen`). `isDesktop` is the
/// exact complement of `isWeb` (upstream `resolveContext` sets
/// `isWeb: !isElectron, isDesktop: isElectron`), so writing one updates the
/// other.
///
/// Unknown names read as `false` and are ignored on write — a typo must
/// never break a keymap rule or throw.
///
/// [evaluate] understands the `when` expression grammar that docs/sdui.md §7
/// defines for `when` — bare context names, `!`, `&&`, `||` and parentheses
/// (§7 also lists comparisons and literals for the node `when` prop; those
/// have no meaning over boolean command contexts and degrade to `false`
/// here). The literals `true` and `false` evaluate to their boolean value
/// (upstream `evaluateWhenNode`). Unknown names evaluate to `false`; any
/// parse failure degrades to `false`. Nothing in this class ever throws.
class WhenContext extends ChangeNotifier {
  /// Creates a context map with every context `false`, except the platform
  /// facts `isWeb` / `isDesktop` which default to the current platform when
  /// not given explicitly (injectable for tests). `isDesktop` is always the
  /// complement of `isWeb`.
  WhenContext({bool? isWeb, bool? isDesktop}) {
    final web = isWeb ?? (isDesktop != null ? !isDesktop : kIsWeb);
    _values['isWeb'] = web;
    _values['isDesktop'] = !web;
  }

  /// The fixed context vocabulary: the twelve upstream-aligned keys plus the
  /// three Jhin palette/sidebar keys.
  static const List<String> contextNames = <String>[
    'terminalFocus',
    'terminalOpen',
    'previewFocus',
    'previewOpen',
    'modelPickerOpen',
    'usagePageOpen',
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

  final Map<String, bool> _values = <String, bool>{
    for (final name in contextNames) name: false,
  };

  /// The current value of one context; unknown names read as `false`.
  bool value(String name) => _values[name] ?? false;

  /// Sets one context; unknown names are ignored. Writing `isWeb` updates
  /// `isDesktop` to its complement and vice versa. Notifies listeners only
  /// when the value actually changes.
  void set(String name, bool newValue) {
    if (name == 'isDesktop') {
      set('isWeb', !newValue);
      return;
    }
    if (!_values.containsKey(name)) return;
    if (_values[name] == newValue) return;
    _values[name] = newValue;
    if (name == 'isWeb') _values['isDesktop'] = !newValue;
    notifyListeners();
  }

  bool get terminalFocus => value('terminalFocus');
  set terminalFocus(bool v) => set('terminalFocus', v);

  bool get terminalOpen => value('terminalOpen');
  set terminalOpen(bool v) => set('terminalOpen', v);

  bool get previewFocus => value('previewFocus');
  set previewFocus(bool v) => set('previewFocus', v);

  bool get previewOpen => value('previewOpen');
  set previewOpen(bool v) => set('previewOpen', v);

  bool get modelPickerOpen => value('modelPickerOpen');
  set modelPickerOpen(bool v) => set('modelPickerOpen', v);

  bool get usagePageOpen => value('usagePageOpen');
  set usagePageOpen(bool v) => set('usagePageOpen', v);

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
/// contexts: `name`, `true`/`false`, `!`, `&&`, `||`, parentheses. Unknown
/// names are `false`; any syntax error fails the whole expression to `false`.
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
    if (name == 'true') return true;
    if (name == 'false') return false;
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
