import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `expanded` (§2.6): `flex` (default `1`), `child`. A thin primitive form
/// of the universal `flex` wrap: when this node itself sits under a `Flex`
/// parent (direct child of `row`/`column`/`flex`), the universal wrap
/// (§2.3 step 14) already applies `Expanded` to IT using its own `flex`
/// prop — rendering the `child` plain is then correct, the outer wrap does
/// the expansion. When there is no `Flex` parent, `Expanded` would crash
/// (Flutter requires a `Flex` ancestor), so this degrades to rendering the
/// child un-wrapped (never a crash, §2.4/§9).
Widget buildExpanded(BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  if (child == null) return degradedBox(context, 'Missing child');
  return child;
}
