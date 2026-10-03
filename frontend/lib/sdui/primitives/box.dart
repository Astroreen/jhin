import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'flex_common.dart';

/// `box` (§2.6): the layout superset of `container`. `child` (single) or
/// `children` (laid out per `direction` when several, honoring the full
/// Flex universal group via [buildFlex]); `shape: rectangle|circle`
/// (default `rectangle`) and `alignment` (alias of the universal `align`)
/// are box's own props.
///
/// Decoration (`color`/`gradient`/`border`/`borderRadius`/`shadow`/`clip`/
/// `opacity`/…) comes from the universal wrapping surface (§2.3), which
/// every node already gets — this builder resolves layout only: a single
/// `child`, or `children` down `direction`. `shape: circle` is read by the
/// universal decoration step too (`render_context.dart`), which drops any
/// `borderRadius` for a circle (Flutter forbids combining the two) rather
/// than crash. `container` is the legacy, simpler sibling primitive — see
/// `container.dart`.
Widget buildBox(BuildContext context, UiNode node, RenderContext ctx) {
  final childrenRaw = node.props['children'];
  if (childrenRaw is List && childrenRaw.isNotEmpty) {
    final direction = node.stringProp('direction') == 'row'
        ? Axis.horizontal
        : Axis.vertical;
    final children = [
      for (final item in childrenRaw)
        ctx.build(context, UiNode.fromJson(item), flexParent: true),
    ];
    return buildFlex(direction: direction, children: children, node: node);
  }
  final child = buildChildProp(context, ctx, node.props['child']);
  if (child != null) {
    final alignment = parseAlignmentLiteral(
        node.props['alignment'] ?? node.props['align']);
    return alignment == null
        ? child
        : Align(alignment: alignment, child: child);
  }
  // No child(ren): a decoration-only box (e.g. a plain color/shape
  // swatch) — the universal surface paints the decoration around this.
  return const SizedBox.shrink();
}
