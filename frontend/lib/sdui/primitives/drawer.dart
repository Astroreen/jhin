import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `drawer` (§8.3): `title?`, `children`.
///
/// A bordered panel with an optional bold title. With no children the
/// panel degrades to a visible placeholder instead of an empty frame.
Widget buildDrawer(BuildContext context, UiNode node, RenderContext ctx) {
  final title = node.stringProp('title');
  return Container(
    decoration: BoxDecoration(
      border: Border.all(color: Theme.of(context).dividerColor),
      borderRadius: BorderRadius.circular(8),
    ),
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
  );
}
