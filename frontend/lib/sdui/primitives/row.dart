import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'flex_common.dart';

/// `row` (§2.6): children laid out horizontally; accepts the full Flex
/// universal group (`mainAxisAlignment`, `crossAxisAlignment`,
/// `mainAxisSize`, `textDirection`, `verticalDirection`, `textBaseline`,
/// `gap`/`spacing`, `overflow`/`clipBehavior`). Every direct child is a
/// `Flex` child, so the universal `flex`/`fit` wrap (§2.3 step 14) applies
/// to all of them, not just the ones that set `flex`. Empty children
/// degrades to a visible placeholder, never a crash.
Widget buildRow(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  final children = [
    for (final child in node.children)
      ctx.build(context, child, flexParent: true),
  ];
  return buildFlex(direction: Axis.horizontal, children: children, node: node);
}
