import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `card` (§8.3): `title?`, `children`.
///
/// With no children the card degrades to a visible placeholder instead of
/// an empty box.
Widget buildCard(BuildContext context, UiNode node, RenderContext ctx) {
  final title = node.stringProp('title');
  return Card(
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null && title.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(title,
                  style: const TextStyle(fontWeight: FontWeight.bold)),
            ),
          if (node.children.isEmpty)
            degradedBox(context, 'Missing children')
          else
            ...buildChildren(context, node, ctx),
        ],
      ),
    ),
  );
}
