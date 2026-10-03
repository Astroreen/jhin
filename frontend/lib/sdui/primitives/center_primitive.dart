import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `center` (§2.6): `child`. Shorthand for `align: center`.
Widget buildCenterPrimitive(BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  if (child == null) return degradedBox(context, 'Missing child');
  return Center(child: child);
}
