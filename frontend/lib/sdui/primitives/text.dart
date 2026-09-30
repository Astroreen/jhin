import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `text` (§8.3): `text`, `style: h1|h2|h3|body|caption|mono`, `bold?`,
/// `color?` (`#RRGGBB`, `#AARRGGBB`, `0xFFRRGGBB` or int).
///
/// A missing `text` prop degrades to a visible placeholder.
Widget buildText(BuildContext context, UiNode node, RenderContext ctx) {
  final text = node.stringProp('text');
  if (text == null) {
    return degradedBox(context, 'Missing text');
  }
  final style = node.stringProp('style') ?? 'body';
  final theme = Theme.of(context);
  TextStyle? base;
  switch (style) {
    case 'h1':
      base = theme.textTheme.headlineMedium;
    case 'h2':
      base = theme.textTheme.headlineSmall;
    case 'h3':
      base = theme.textTheme.titleLarge;
    case 'caption':
      base = theme.textTheme.bodySmall;
    case 'mono':
      base = theme.textTheme.bodyMedium?.copyWith(fontFamily: 'monospace');
    default:
      base = theme.textTheme.bodyMedium;
  }
  final color = parseColor(node.props['color']);
  return Text(
    text,
    style: base?.copyWith(
      fontWeight: node.boolProp('bold') == true ? FontWeight.bold : null,
      color: color,
    ),
  );
}
