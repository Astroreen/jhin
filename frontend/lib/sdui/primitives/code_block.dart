import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `code_block` (§2.6): `code` (required), `language` (a plain label — an
/// unknown language is just a label), `wrap` (wrap long lines), `copyable`
/// (copy affordance: exact source to the clipboard plus a toast),
/// `maxLines` (line limit) and `lineNumbers` (optional line numbers).
///
/// The code style is the `$font.mono` token (the `mono` typography seed);
/// the language label and the line numbers sit above/beside the code. A
/// missing `code` prop degrades to a visible placeholder (§2.4).
Widget buildCodeBlock(BuildContext context, UiNode node, RenderContext ctx) {
  final code = node.stringProp('code');
  if (code == null) {
    return degradedBox(context, 'Missing code');
  }
  final design = JhinDesignScope.of(context);
  final tokens = design.tokens;
  final theme = JhinDesignScope.materialOf(context);

  final monoFamily = tokens.resolveToken(r'$font.mono');
  var codeStyle = tokens.typography.mono;
  if (monoFamily is String && monoFamily.isNotEmpty) {
    codeStyle = codeStyle.copyWith(fontFamily: monoFamily);
  }
  final labelStyle =
      tokens.typography.small.copyWith(color: theme.colorScheme.onSurfaceVariant);
  final numberStyle = codeStyle.copyWith(color: theme.disabledColor);

  final language = node.stringProp('language');
  final wrap = node.boolProp('wrap') == true;
  final copyable = node.boolProp('copyable') == true;
  final maxLines = node.numProp('maxLines')?.round();
  final lineNumbers = node.boolProp('lineNumbers') == true;

  final lines = code.split('\n');
  final limit = maxLines != null && maxLines > 0 && maxLines < lines.length
      ? maxLines
      : lines.length;

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
              Expanded(child: Text(lines[index], style: codeStyle, softWrap: wrap)),
            ],
          ),
      ],
    );
  } else {
    final text = Text(
      code,
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
    padding: EdgeInsets.all(tokens.spacing.md),
    decoration: BoxDecoration(
      color: theme.colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(tokens.radius.sm),
      border: Border.all(color: theme.colorScheme.outlineVariant),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (language != null || copyable)
          Row(
            children: [
              if (language != null) Expanded(child: Text(language, style: labelStyle)),
              if (copyable)
                IconButton(
                  icon: Icon(iconFor('copy')),
                  tooltip: 'Copy code',
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: code));
                    await ctx.runDirectives([
                      {'op': 'toast', 'text': 'Copied to clipboard'},
                    ]);
                  },
                ),
            ],
          ),
        body,
      ],
    ),
  );
}
