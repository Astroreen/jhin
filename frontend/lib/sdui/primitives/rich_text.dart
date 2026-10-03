import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../directives.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'text_common.dart';

/// `rich_text` (§2.6): `spans` — an inline span array of
/// `{text, style, action, tooltip}`.
///
/// Spans become `TextSpan`s inside one `Text.rich`; a span with `tooltip`
/// wraps in a `WidgetSpan` so the tooltip can hover over its own text. A
/// tappable `action` attaches a tap recognizer that dispatches through
/// [RenderContext.dispatch]; an unknown action (no `path` and no known
/// directive `op`) drops the action and keeps the text (§2.6 span table).
/// Unknown span fields are ignored (§2.4). A missing or empty `spans` array
/// degrades to a visible placeholder.
Widget buildRichText(BuildContext context, UiNode node, RenderContext ctx) {
  final spans = node.listProp('spans');
  if (spans == null || spans.isEmpty) {
    return degradedBox(context, 'Missing spans');
  }
  return _RichTextRun(spans: spans, ctx: ctx, props: node.props);
}

/// The tappable/tooltip span runner: owns one [TapGestureRecognizer] per
/// tappable span and disposes them with the widget.
class _RichTextRun extends StatefulWidget {
  const _RichTextRun({required this.spans, required this.ctx, required this.props});

  final List<Object?> spans;
  final RenderContext ctx;
  final Map<String, dynamic> props;

  @override
  State<_RichTextRun> createState() => _RichTextRunState();
}

class _RichTextRunState extends State<_RichTextRun> {
  final Map<int, TapGestureRecognizer> _recognizers = {};

  @override
  void dispose() {
    for (final recognizer in _recognizers.values) {
      recognizer.dispose();
    }
    super.dispose();
  }

  /// The legacy level-1 text props (`style`, `bold`, `italic`, `color`) as
  /// the default span style (§2.1); null when none is set.
  TextStyle? _baseStyle(JhinTheme design) {
    var style = typographyStyle(
        widget.props['style'] is String ? widget.props['style'] as String : null,
        design.tokens);
    if (widget.props['bold'] == true) {
      style = (style ?? const TextStyle()).copyWith(fontWeight: FontWeight.bold);
    }
    if (widget.props['italic'] == true) {
      style = (style ?? const TextStyle()).copyWith(fontStyle: FontStyle.italic);
    }
    final color = parseColor(widget.props['color']);
    if (color != null) {
      style = (style ?? const TextStyle()).copyWith(color: color);
    }
    return style;
  }

  @override
  Widget build(BuildContext context) {
    final design = JhinDesignScope.of(context);
    final children = <InlineSpan>[];
    _recognizers.clear();
    for (var index = 0; index < widget.spans.length; index++) {
      final span = _parseSpan(widget.spans[index], design, index);
      if (span != null) children.add(span);
    }
    return Text.rich(TextSpan(children: children), style: _baseStyle(design));
  }

  InlineSpan? _parseSpan(Object? raw, JhinTheme design, int index) {
    final map = raw is Map ? Map<String, dynamic>.from(raw) : null;
    final text = map == null
        ? (raw is String ? raw : null)
        : (map['text'] is String ? map['text'] as String : null);
    if (text == null) return null;
    final style = map == null
        ? null
        : (map['style'] is String
            ? typographyStyle(map['style'] as String, design.tokens)
            : parseTextStyleMap(map['style']));
    final action = map == null ? null : asMap(map['action']);
    final dispatchable = action != null && _isDispatchable(action);
    final tooltip = map == null
        ? null
        : (map['tooltip'] is String && (map['tooltip'] as String).isNotEmpty
            ? map['tooltip'] as String
            : null);

    TapGestureRecognizer? recognizer;
    if (dispatchable) {
      recognizer = TapGestureRecognizer()
        ..onTap = () => widget.ctx.dispatch(action);
      _recognizers[index] = recognizer;
    }
    final span = TextSpan(text: text, style: style, recognizer: recognizer);
    if (tooltip == null) return span;
    return WidgetSpan(
      child: Tooltip(
        message: tooltip,
        child: Text.rich(span),
      ),
    );
  }

  /// A dispatchable action (§3): a server action with a `path`, or an
  /// inline directive with a known `op`. Anything else drops the action and
  /// keeps the text (§2.6 span table).
  static bool _isDispatchable(Map<String, dynamic> action) {
    final path = action['path'];
    if (path is String && path.isNotEmpty) return true;
    final op = action['op'];
    return op is String && isKnownDirectiveOp(op);
  }
}
