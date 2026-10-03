import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'scroll_common.dart';

/// `grid` (§2.6) over `GridView.count`: `columns` (required; `0` degrades
/// to `1`), `childAspectRatio` (default `1.0`), `crossAxisSpacing` and
/// `mainAxisSpacing` (default `0`), `shrinkWrap` (default `false`),
/// `physics` (§2.6 literals) and `children` (the cells). `padding` is the
/// universal Box prop (§2.1) and wraps the grid from outside.
///
/// A missing `columns` degrades to a visible placeholder and a
/// non-positive `childAspectRatio` to `1.0` (Flutter's grid delegate
/// asserts on ratios <= 0). The scroller keeps its lazy viewport in a
/// bounded slot and degrades to shrink-wrap in an unbounded parent
/// (`scroll_common.dart`) — never a crash.
Widget buildGrid(BuildContext context, UiNode node, RenderContext ctx) {
  if (node.children.isEmpty) {
    return degradedBox(context, 'Missing children');
  }
  final rawColumns = node.numProp('columns');
  if (rawColumns == null) {
    return degradedBox(context, 'Missing columns');
  }
  final columns = rawColumns.round() <= 0 ? 1 : rawColumns.round();
  final ratio = node.numProp('childAspectRatio')?.toDouble();
  final childAspectRatio = ratio == null || ratio <= 0 ? 1.0 : ratio;
  final children = buildChildren(context, node, ctx);
  return buildAdaptiveScroller(
    scrollDirection: Axis.vertical,
    shrinkWrap: node.boolProp('shrinkWrap') ?? false,
    scroller: (shrinkWrap) => GridView.count(
      crossAxisCount: columns,
      childAspectRatio: childAspectRatio,
      crossAxisSpacing: node.numProp('crossAxisSpacing')?.toDouble() ?? 0,
      mainAxisSpacing: node.numProp('mainAxisSpacing')?.toDouble() ?? 0,
      shrinkWrap: shrinkWrap,
      physics: parseScrollPhysics(node.stringProp('physics')),
      children: children,
    ),
  );
}
