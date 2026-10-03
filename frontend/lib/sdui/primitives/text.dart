import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'text_common.dart';

/// `text` (§2.6): `text` (required), `style` typography token
/// (`h1`/`h2`/`h3`/`body`/`small`/`caption`/`mono`; `caption` maps to
/// `small`), `bold`, `italic`, `color`, `strutStyle`
/// (`{size?, height?, leading?}`), `textWidthBasis`
/// (`parent`/`longestLine`/`character`), `locale` (BCP-47) and
/// `selectionColor`. The universal Text group (`fontFamily`…`textOverflow`,
/// `maxLines`, `softWrap`, `ellipsis`) is applied by the registry (§2.3
/// step 2) on top of the built style.
///
/// A missing `text` prop degrades to a visible placeholder; an unknown
/// `style` token degrades to the default `body` (§2.4).
Widget buildText(BuildContext context, UiNode node, RenderContext ctx) {
  final text = node.stringProp('text');
  if (text == null) {
    return degradedBox(context, 'Missing text');
  }
  final design = JhinDesignScope.of(context);
  var style = typographyStyle(node.stringProp('style'), design.tokens) ??
      design.tokens.typography.body;
  if (node.boolProp('bold') == true) {
    style = style.copyWith(fontWeight: FontWeight.bold);
  }
  if (node.boolProp('italic') == true) {
    style = style.copyWith(fontStyle: FontStyle.italic);
  }
  final color = parseColor(node.props['color']);
  if (color != null) {
    style = style.copyWith(color: color);
  }
  return Text(
    text,
    style: style,
    strutStyle: parseStrutStyle(node.props['strutStyle']),
    textWidthBasis: parseTextWidthBasis(node.stringProp('textWidthBasis')),
    locale: parseLocale(node.stringProp('locale')),
    selectionColor: parseColor(node.props['selectionColor']),
  );
}
