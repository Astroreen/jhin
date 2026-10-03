import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `positioned` (§2.6): `top`/`right`/`bottom`/`left`/`width`/`height` +
/// `child`.
///
/// The [Positioned] wrapper is applied by the registry (§2.3) around this
/// node's whole universal wrapping when the parent marks it
/// `stackParent: true` — Flutter requires the parent-data widget to be the
/// direct child of its [Stack]. Without a `stack` parent the node degrades
/// to `align` (§2.4): the child renders centered and never crashes. This
/// builder therefore renders only the plain `child` slot.
Widget buildPositioned(BuildContext context, UiNode node, RenderContext ctx) {
  final child = buildChildProp(context, ctx, node.props['child']);
  return child ?? degradedBox(context, 'Missing child');
}
