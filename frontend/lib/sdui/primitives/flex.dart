import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'flex_common.dart';

/// `flex` (§2.6): `direction: row|column` (required; missing/unknown
/// degrades to `column`) plus the full Flex universal group and `children`.
/// The explicit primitive form of `row`/`column` for servers that want to
/// pick the axis dynamically from one node type.
Widget buildFlexPrimitive(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  final direction =
      node.stringProp('direction') == 'row' ? Axis.horizontal : Axis.vertical;
  final children = [
    for (final child in node.children)
      ctx.build(context, child, flexParent: true),
  ];
  return buildFlex(direction: direction, children: children, node: node);
}
