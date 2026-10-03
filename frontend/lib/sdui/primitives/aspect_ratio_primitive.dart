import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `aspect_ratio` (§2.6, added by T58 — the doc's §2.1 Box group already
/// carries a universal `aspectRatio` that wraps any node's own rendering;
/// this primitive is the explicit standalone form, wrapping a `child` slot):
/// `aspectRatio` (required num; missing/non-positive degrades to rendering
/// the child unwrapped), `child`.
Widget buildAspectRatioPrimitive(
    BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  if (child == null) return degradedBox(context, 'Missing child');
  final ratio = node.numProp('aspectRatio')?.toDouble();
  if (ratio == null || ratio <= 0) return child;
  return AspectRatio(aspectRatio: ratio, child: child);
}
