import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `code_block` (§2.6): `code` (required), `language` (a plain label — an
/// unknown language is just a label), `wrap` (wrap long lines), `copyable`
/// (copy affordance: exact source to the clipboard plus a toast),
/// `maxLines` (line limit), `lineNumbers` (optional line numbers) and
/// `syntax` (T104: token-driven syntax colouring).
///
/// The code style is the `$font.mono` token (the `mono` typography seed).
/// T104: the header follows the upstream
/// `.chat-markdown-codeblock-header` recipe (t3code index.css:1440-1442,
/// 1942-1944) — the language label in the code foreground at 72% opacity
/// and the always-visible ghost copy button that brightens on hover (the
/// upstream buttons are always in the DOM, ChatMarkdown.tsx:1089-1138; the
/// copied state flips the glyph to the check for 1.2 s,
/// ChatMarkdown.tsx:1025). `syntax: true` colours keywords, strings,
/// numbers and comments through the semantic tokens — the Shiki themes'
/// five roles mapped onto `$color.accent`/`$color.success`/
/// `$color.warning`/`$color.muted-foreground`/`$color.info` (the mapping
/// is recorded in `.sisyphus/evidence/T104/syntax-map.md`).
///
/// A missing `code` prop degrades to a visible placeholder (§2.4).
Widget buildCodeBlock(BuildContext context, UiNode node, RenderContext ctx) {
  final code = node.stringProp('code');
  if (code == null) {
    return degradedBox(context, 'Missing code');
  }
  final design = JhinDesignScope.of(context);
  final tokens = design.tokens;
  final theme = JhinDesignScope.materialOf(context);
  final brightness = Theme.brightnessOf(context);

  final monoFamily = tokens.resolveToken(r'$font.mono');
  var codeStyle = tokens.typography.mono;
  if (monoFamily is String && monoFamily.isNotEmpty) {
    codeStyle = codeStyle.copyWith(fontFamily: monoFamily);
  }
  // The header recipe: the code foreground mixed 72% toward transparent —
  // `color-mix(in srgb, var(--code-foreground) 72%, transparent)`.
  final headerColor =
      design.colorOf('code-foreground', brightness: brightness)?.withValues(alpha: 0.72) ??
          theme.colorScheme.onSurfaceVariant;
  final labelStyle = tokens.typography.small
      .copyWith(fontFamily: codeStyle.fontFamily, color: headerColor);
  final numberStyle = codeStyle.copyWith(color: theme.disabledColor);

  final language = node.stringProp('language');
  final wrap = node.boolProp('wrap') == true;
  final copyable = node.boolProp('copyable') == true;
  final syntax = node.boolProp('syntax') == true;
  final maxLines = node.numProp('maxLines')?.round();
  final lineNumbers = node.boolProp('lineNumbers') == true;

  final lines = code.split('\n');
  final limit = maxLines != null && maxLines > 0 && maxLines < lines.length
      ? maxLines
      : lines.length;
  final highlighter =
      syntax ? JhinSyntaxHighlighter(design: design, brightness: brightness) : null;

  final Widget body;
  if (lineNumbers) {
    body = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var index = 0; index < limit; index++)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${index + 1}', style: numberStyle),
              SizedBox(width: tokens.spacing.sm),
              Expanded(
                child: highlighter == null
                    ? Text(lines[index], style: codeStyle, softWrap: wrap)
                    : highlighter.text(lines[index], style: codeStyle, wrap: wrap),
              ),
            ],
          ),
      ],
    );
  } else {
    final text = highlighter == null
        ? Text(
            code,
            style: codeStyle,
            softWrap: wrap,
            maxLines: maxLines != null && maxLines > 0 ? maxLines : null,
            overflow: maxLines != null && maxLines > 0
                ? TextOverflow.ellipsis
                : TextOverflow.clip,
          )
        : Text.rich(
            highlighter.spans(code, style: codeStyle),
            style: codeStyle,
            softWrap: wrap,
            maxLines: maxLines != null && maxLines > 0 ? maxLines : null,
            overflow: maxLines != null && maxLines > 0
                ? TextOverflow.ellipsis
                : TextOverflow.clip,
          );
    body = wrap
        ? text
        : SingleChildScrollView(scrollDirection: Axis.horizontal, child: text);
  }

  return Container(
    padding: insetAll(tokens.spacing.md),
    decoration: BoxDecoration(
      color: design.colorOf('code', brightness: brightness) ??
          theme.colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(tokens.radius.sm),
      border: Border.all(
        color: design.colorOf('border', brightness: brightness) ??
            theme.colorScheme.outlineVariant,
      ),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (language != null || copyable)
          _CodeBlockHeader(
            language: language,
            labelStyle: labelStyle,
            copyable: copyable,
            code: code,
            ctx: ctx,
          ),
        body,
      ],
    ),
  );
}

/// The `.chat-markdown-codeblock-header` recipe: the muted language label
/// on the left, the ghost copy action on the right, brightening on hover.
class _CodeBlockHeader extends StatefulWidget {
  const _CodeBlockHeader({
    required this.language,
    required this.labelStyle,
    required this.copyable,
    required this.code,
    required this.ctx,
  });

  final String? language;
  final TextStyle labelStyle;
  final bool copyable;
  final String code;
  final RenderContext ctx;

  @override
  State<_CodeBlockHeader> createState() => _CodeBlockHeaderState();
}

class _CodeBlockHeaderState extends State<_CodeBlockHeader> {
  bool _hover = false;
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    await widget.ctx.runDirectives([
      {'op': 'toast', 'text': 'Copied to clipboard'},
    ]);
    // The copied glyph holds for 1.2 s (upstream ChatMarkdown.tsx:1025).
    await Future<void>.delayed(const Duration(milliseconds: 1200));
    if (mounted) setState(() => _copied = false);
  }

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final brightness = Theme.brightnessOf(context);
    // The ghost-muted action: the header colour, brightening on hover
    // (the upstream `variant="ghost-muted"` button, ChatMarkdown.tsx:1052-1069).
    final idle = design
            .colorOf('code-foreground', brightness: brightness)
            ?.withValues(alpha: 0.72) ??
        Theme.of(context).colorScheme.onSurfaceVariant;
    final actionColor = _hover ? design.colorOf('code-foreground', brightness: brightness) ?? idle : idle;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: Row(
        children: [
          if (widget.language != null)
            Expanded(child: Text(widget.language!, style: widget.labelStyle)),
          if (widget.copyable)
            IconButton(
              icon: Icon(iconFor(_copied ? 'check' : 'copy'),
                  size: 14, color: actionColor),
              tooltip: _copied ? 'Copied' : 'Copy code',
              onPressed: _copy,
            ),
        ],
      ),
    );
  }
}

/// The token-driven syntax highlighter (T104): a pure-Dart scanner colouring
/// comments, strings, numbers and keywords through the semantic tokens —
/// the mapped roles of the upstream Shiki themes. Unknown constructs keep
/// the code foreground; nothing throws on malformed input.
class JhinSyntaxHighlighter {
  JhinSyntaxHighlighter({required this.design, required this.brightness});

  final JhinTheme design;
  final Brightness brightness;

  static const Set<String> _keywords = {
    'abstract', 'and', 'as', 'assert', 'async', 'await', 'base', 'bool', 'break',
    'case', 'catch', 'class', 'const', 'continue', 'covariant', 'default',
    'deferred', 'do', 'double', 'dynamic', 'else', 'enum', 'export', 'extends',
    'extension', 'external', 'factory', 'false', 'final', 'finally', 'float',
    'for', 'Function', 'get', 'hide', 'if', 'implements', 'import', 'in',
    'int', 'interface', 'is', 'late', 'library', 'mixin', 'new', 'not', 'null',
    'on', 'operator', 'or', 'part', 'private', 'protected', 'public', 'raise',
    'required', 'rethrow', 'return', 'sealed', 'set', 'show', 'static', 'super',
    'switch', 'sync', 'this', 'throw', 'true', 'try', 'type', 'typedef', 'var',
    'void', 'when', 'while', 'with', 'yield',
  };

  final _word = RegExp(r'[A-Za-z_][A-Za-z0-9_]*');
  final _number = RegExp(r'\b\d+(?:\.\d+)?\b');

  Color? _role(String name) => design.colorOf(name, brightness: brightness);

  /// The highlighted span tree of the whole [code]: the `\n` separators
  /// stay plain so one `Text.rich` keeps the shared wrap/scroll behaviour.
  TextSpan spans(String code, {required TextStyle style}) {
    final children = <TextSpan>[];
    final lines = code.split('\n');
    for (var index = 0; index < lines.length; index++) {
      if (index > 0) children.add(const TextSpan(text: '\n'));
      _highlightLine(lines[index], style, children);
    }
    return TextSpan(children: children);
  }

  /// The highlighted single-line widget (the `lineNumbers` path).
  Widget text(String line, {required TextStyle style, required bool wrap}) {
    final spans = <TextSpan>[];
    _highlightLine(line, style, spans);
    return Text.rich(TextSpan(children: spans, style: style), softWrap: wrap);
  }

  void _highlightLine(String line, TextStyle style, List<TextSpan> spans) {
    var cursor = 0;
    void push(int start, int end, TextStyle? spanStyle) {
      if (end <= start) return;
      final content = line.substring(start, end);
      spans.add(spanStyle == null
          ? TextSpan(text: content)
          : TextSpan(text: content, style: spanStyle));
    }

    while (cursor < line.length) {
      final comment = _commentStart(line, cursor);
      if (comment != null) {
        push(cursor, line.length, style.copyWith(color: _role('muted-foreground')));
        cursor = line.length;
        break;
      }
      final quote = _quoteCharAt(line, cursor);
      if (quote != null) {
        final end = line.indexOf(quote, cursor + 1);
        final stop = end == -1 ? line.length : end + 1;
        push(cursor, stop, style.copyWith(color: _role('success')));
        cursor = stop;
        continue;
      }
      final word = _word.matchAsPrefix(line, cursor);
      if (word != null) {
        final token = word.group(0)!;
        push(cursor, cursor + token.length,
            _keywords.contains(token) ? style.copyWith(color: _role('accent')) : null);
        cursor += token.length;
        continue;
      }
      final number = _number.matchAsPrefix(line, cursor);
      if (number != null) {
        push(cursor, cursor + number.group(0)!.length,
            style.copyWith(color: _role('warning')));
        cursor += number.group(0)!.length;
        continue;
      }
      push(cursor, cursor + 1, null);
      cursor++;
    }
  }

  /// The comment opener at [index]: `//`, or `#` only when the next char is
  /// a space or the line ends (keeps `#` hex colours and `#!` shebangs out
  /// of the comment role).
  int? _commentStart(String line, int index) {
    if (index + 1 < line.length &&
        line[index] == '/' &&
        line[index + 1] == '/') {
      return index;
    }
    if (line[index] == '#' &&
        (index + 1 >= line.length ||
            line[index + 1] == ' ' ||
            line[index + 1] == '\t')) {
      return index;
    }
    return null;
  }

  String? _quoteCharAt(String line, int index) {
    final char = line[index];
    return (char == '"' || char == "'" || char == '`') ? char : null;
  }
}
