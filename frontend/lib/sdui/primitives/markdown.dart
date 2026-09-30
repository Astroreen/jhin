import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `markdown` (§8.3): `text`.
///
/// Rendered as plain text — no markdown dependency (AGENTS.md rule 3,
/// accepted T22 deviation). A missing `text` prop degrades to a visible
/// placeholder.
Widget buildMarkdown(BuildContext context, UiNode node, RenderContext ctx) {
  final text = node.stringProp('text');
  if (text == null) {
    return degradedBox(context, 'Missing text');
  }
  return Text(text);
}
