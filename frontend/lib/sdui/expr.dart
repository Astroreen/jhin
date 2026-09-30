/// Tiny client-side expression grammar (§8.7) for `when` and `${…}`.
///
/// Supported: field references, `!`, `==`, `!=`, `>`, `>=`, `<`, `<=`,
/// `&&`, `||`, parentheses, string/number/bool literals. Nothing else —
/// no arithmetic, no functions, no method calls.
///
/// Any parse or evaluation failure degrades silently: [evalWhen] returns
/// null (the node stays visible) and [interpolate] leaves the failing
/// `${…}` literal in place. Unknown constructs therefore never break an
/// older client.
library;

import 'ui_state.dart';

/// Evaluates a `when` expression against [state].
///
/// Returns `true` (show), `false` (hide) or `null` (degrade: keep visible).
bool? evalWhen(String expression, UiState state) {
  try {
    final value = _Evaluator(state).evaluate(_Parser(_tokenize(expression)).parse());
    return value is bool ? value : null;
  } catch (_) {
    return null;
  }
}

/// Interpolates `${…}` fragments of [template] over [state].
///
/// A fragment whose expression fails to parse or evaluate is left in the
/// output verbatim (the literal text is shown); the rest still interpolates.
String interpolate(String template, UiState state) {
  final buffer = StringBuffer();
  var index = 0;
  while (index < template.length) {
    final start = template.indexOf('\${', index);
    if (start < 0) {
      buffer.write(template.substring(index));
      break;
    }
    buffer.write(template.substring(index, start));
    final end = template.indexOf('}', start + 2);
    if (end < 0) {
      buffer.write(template.substring(start));
      break;
    }
    final source = template.substring(start + 2, end);
    String replacement;
    try {
      final value =
          _Evaluator(state).evaluate(_Parser(_tokenize(source)).parse());
      replacement = _stringify(value);
    } catch (_) {
      replacement = template.substring(start, end + 1);
    }
    buffer.write(replacement);
    index = end + 1;
  }
  return buffer.toString();
}

String _stringify(Object? value) {
  if (value == null) return 'null';
  return '$value';
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

enum _TokenKind { identifier, number, string, bool, op, end }

class _Token {
  const _Token(this.kind, this.text, this.number, this.string);

  factory _Token.number(String text, num value) =>
      _Token(_TokenKind.number, text, value, null);

  factory _Token.string(String text, String value) =>
      _Token(_TokenKind.string, text, null, value);

  factory _Token.op(String text) => _Token(_TokenKind.op, text, null, null);

  final _TokenKind kind;
  final String text;
  final num? number;
  final String? string;
}

List<_Token> _tokenize(String source) {
  final tokens = <_Token>[];
  var i = 0;
  while (i < source.length) {
    final char = source[i];
    if (char == ' ' || char == '\t' || char == '\n' || char == '\r') {
      i++;
      continue;
    }
    // Two-character operators first.
    if (i + 1 < source.length) {
      final pair = source.substring(i, i + 2);
      if (pair == '==' ||
          pair == '!=' ||
          pair == '>=' ||
          pair == '<=' ||
          pair == '&&' ||
          pair == '||') {
        tokens.add(_Token.op(pair));
        i += 2;
        continue;
      }
    }
    if (char == '!' || char == '>' || char == '<' || char == '(' || char == ')') {
      tokens.add(_Token.op(char));
      i++;
      continue;
    }
    if (char == '"' || char == "'") {
      final end = source.indexOf(char, i + 1);
      if (end < 0) throw const FormatException('unterminated string');
      tokens.add(_Token.string(source.substring(i, end + 1), source.substring(i + 1, end)));
      i = end + 1;
      continue;
    }
    final numberMatch = _numberPattern.matchAsPrefix(source, i);
    if (numberMatch != null) {
      final text = numberMatch.group(0)!;
      final value =
          text.contains('.') ? double.parse(text) : int.parse(text) as num;
      tokens.add(_Token.number(text, value));
      i += text.length;
      continue;
    }
    final identifierMatch = _identifierPattern.matchAsPrefix(source, i);
    if (identifierMatch != null) {
      final text = identifierMatch.group(0)!;
      if (text == 'true' || text == 'false') {
        tokens.add(_Token(_TokenKind.bool, text, null, null));
      } else {
        tokens.add(_Token(_TokenKind.identifier, text, null, null));
      }
      i += text.length;
      continue;
    }
    throw FormatException('unexpected character: $char');
  }
  tokens.add(const _Token(_TokenKind.end, '', null, null));
  return tokens;
}

final _numberPattern = RegExp(r'-?\d+(\.\d+)?');
final _identifierPattern = RegExp(r'[A-Za-z_][A-Za-z0-9_]*');

// ---------------------------------------------------------------------------
// Parser — recursive descent over the §8.7 grammar
// ---------------------------------------------------------------------------

abstract class _Expr {
  const _Expr();

  Object? accept(_Evaluator evaluator);
}

class _Literal extends _Expr {
  const _Literal(this.value);
  final Object? value;

  @override
  Object? accept(_Evaluator evaluator) => evaluator.visitLiteral(this);
}

class _Field extends _Expr {
  const _Field(this.name);
  final String name;

  @override
  Object? accept(_Evaluator evaluator) => evaluator.visitField(this);
}

class _Not extends _Expr {
  const _Not(this.operand);
  final _Expr operand;

  @override
  Object? accept(_Evaluator evaluator) => evaluator.visitNot(this);
}

class _Binary extends _Expr {
  const _Binary(this.op, this.left, this.right);
  final String op;
  final _Expr left;
  final _Expr right;

  @override
  Object? accept(_Evaluator evaluator) => evaluator.visitBinary(this);
}

class _Parser {
  _Parser(this._tokens);

  final List<_Token> _tokens;
  int _index = 0;

  _Token get _current => _tokens[_index];

  _Expr parse() {
    final expression = _parseOr();
    if (_current.kind != _TokenKind.end) {
      throw FormatException('unexpected token: ${_current.text}');
    }
    return expression;
  }

  _Expr _parseOr() {
    var left = _parseAnd();
    while (_current.kind == _TokenKind.op && _current.text == '||') {
      _index++;
      left = _Binary('||', left, _parseAnd());
    }
    return left;
  }

  _Expr _parseAnd() {
    var left = _parseEquality();
    while (_current.kind == _TokenKind.op && _current.text == '&&') {
      _index++;
      left = _Binary('&&', left, _parseEquality());
    }
    return left;
  }

  _Expr _parseEquality() {
    var left = _parseRelational();
    while (_current.kind == _TokenKind.op &&
        (_current.text == '==' || _current.text == '!=')) {
      final op = _current.text;
      _index++;
      left = _Binary(op, left, _parseRelational());
    }
    return left;
  }

  _Expr _parseRelational() {
    var left = _parseUnary();
    while (_current.kind == _TokenKind.op &&
        (_current.text == '>' ||
            _current.text == '>=' ||
            _current.text == '<' ||
            _current.text == '<=')) {
      final op = _current.text;
      _index++;
      left = _Binary(op, left, _parseUnary());
    }
    return left;
  }

  _Expr _parseUnary() {
    if (_current.kind == _TokenKind.op && _current.text == '!') {
      _index++;
      return _Not(_parseUnary());
    }
    return _parsePrimary();
  }

  _Expr _parsePrimary() {
    final token = _current;
    switch (token.kind) {
      case _TokenKind.bool:
        _index++;
        return _Literal(token.text == 'true');
      case _TokenKind.number:
        _index++;
        return _Literal(token.number);
      case _TokenKind.string:
        _index++;
        return _Literal(token.string);
      case _TokenKind.identifier:
        _index++;
        return _Field(token.text);
      case _TokenKind.op:
        if (token.text == '(') {
          _index++;
          final inner = _parseOr();
          if (_current.kind != _TokenKind.op || _current.text != ')') {
            throw const FormatException('missing ")"');
          }
          _index++;
          return inner;
        }
        throw FormatException('unexpected operator: ${token.text}');
      case _TokenKind.end:
        throw const FormatException('unexpected end of expression');
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

class _Evaluator {
  const _Evaluator(this.state);

  final UiState state;

  Object? evaluate(_Expr expression) => expression.accept(this);

  Object? visitLiteral(_Literal expression) => expression.value;

  Object? visitField(_Field expression) {
    final value = state[expression.name];
    if (value == null) {
      throw StateError('unknown field: ${expression.name}');
    }
    return value;
  }

  Object? visitNot(_Not expression) {
    final operand = evaluate(expression.operand);
    if (operand is! bool) throw StateError('"!" expects a bool');
    return !operand;
  }

  Object? visitBinary(_Binary expression) {
    final op = expression.op;
    if (op == '&&' || op == '||') {
      final left = evaluate(expression.left);
      if (left is! bool) throw StateError('"$op" expects bools');
      if (op == '&&' && !left) return false;
      if (op == '||' && left) return true;
      final right = evaluate(expression.right);
      if (right is! bool) throw StateError('"$op" expects bools');
      return right;
    }
    final left = evaluate(expression.left);
    final right = evaluate(expression.right);
    switch (op) {
      case '==':
        return _equals(left, right);
      case '!=':
        return !_equals(left, right);
      case '>':
        return _compare(left, right) > 0;
      case '>=':
        return _compare(left, right) >= 0;
      case '<':
        return _compare(left, right) < 0;
      case '<=':
        return _compare(left, right) <= 0;
    }
    throw StateError('unknown operator: $op');
  }

  static bool _equals(Object? left, Object? right) => left == right;

  static int _compare(Object? left, Object? right) {
    if (left is num && right is num) return left.compareTo(right);
    if (left is String && right is String) return left.compareTo(right);
    throw StateError('cannot compare ${left.runtimeType} and ${right.runtimeType}');
  }
}
