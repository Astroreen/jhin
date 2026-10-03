import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `flexible` (§2.6): `flex` (default `1`), `fit` (default `loose`),
/// `child`. See [buildExpanded] — the actual `Flexible`/`Expanded` wrap
/// happens in the universal surface (§2.3 step 14) when this node is a
/// direct `Flex` child; elsewhere it degrades to the plain child.
Widget buildFlexible(BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  if (child == null) return degradedBox(context, 'Missing child');
  return child;
}
