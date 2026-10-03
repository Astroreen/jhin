import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `sized_box` (§2.6): `width`, `height`, `child`. Exact box constraints —
/// a dedicated primitive form of the universal `width`/`height` (§2.1 Box
/// group), useful when the width/height need to apply to a nested `child`
/// slot rather than to this node's own universal wrapping.
Widget buildSizedBox(BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  final width = node.numProp('width')?.toDouble();
  final height = node.numProp('height')?.toDouble();
  return SizedBox(width: width, height: height, child: child);
}
