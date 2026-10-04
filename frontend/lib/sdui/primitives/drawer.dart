import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `drawer` (§8.3): `title?`, `children`.
///
/// A bordered panel with an optional bold title. With no children the
/// panel degrades to a visible placeholder instead of an empty frame.
Widget buildDrawer(BuildContext context, UiNode node, RenderContext ctx) {
  final title = node.stringProp('title');
  final tokens = JhinDesignScope.of(context).tokens;
  return Container(
    decoration: BoxDecoration(
      border: Border.all(color: JhinDesignScope.materialOf(context).dividerColor),
      borderRadius: BorderRadius.circular(tokens.radius.sm),
    ),
    padding: EdgeInsets.all(tokens.spacing.md),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null && title.isNotEmpty)
          Padding(
            padding: EdgeInsets.only(bottom: tokens.spacing.sm),
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
