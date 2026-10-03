import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'flex_common.dart';

/// `column` (§2.6): children laid out vertically; accepts the full Flex
/// universal group. See [buildRow] for the shared semantics.
Widget buildColumn(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  final children = [
    for (final child in node.children)
      ctx.build(context, child, flexParent: true),
  ];
  return buildFlex(direction: Axis.vertical, children: children, node: node);
}
