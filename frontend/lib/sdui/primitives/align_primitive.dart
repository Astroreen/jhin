import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `align` (§2.6): `align` (default `center`; `alignment` accepted as an
/// alias), `child`. An unknown alignment literal degrades to `center`
/// (§2.4), never a crash.
Widget buildAlignPrimitive(BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  if (child == null) return degradedBox(context, 'Missing child');
  final alignment =
      parseAlignmentLiteral(node.props['align'] ?? node.props['alignment']) ??
          Alignment.center;
  return Align(alignment: alignment, child: child);
}
