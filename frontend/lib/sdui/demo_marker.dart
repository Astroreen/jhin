import 'package:flutter/material.dart';

import '../design/theme.dart';
import 'ui_node.dart';

/// The shared disabled-affordance of the level-3 `demo` marker (§2.1): the
/// tooltip text every decorative node carries.
const String kDemoTooltip = 'Preview only — not available in this build';

/// Wraps a rendered node with the shared demo affordance when the node
/// carries `demo: true` (§2.1 level 3): the shared tooltip plus the small
/// corner badge marking the node as a preview. Decorative nodes dispatch
/// inline directives only — the marker keeps them from looking silently
/// real (the T117 sweep enforces the marking server-side).
///
/// Nodes without the marker pass through unchanged.
Widget applyDemoMarker(Widget child, UiNode node, BuildContext context) {
  if (node.boolProp('demo') != true) return child;
  final theme = JhinDesignScope.materialOf(context);
  final tokens = JhinDesignScope.of(context).tokens;
  final badge = Positioned(
    top: 0,
    right: 0,
    child: Container(
      padding: EdgeInsets.fromLTRB(
          tokens.spacing.xs, tokens.spacing.xs / 2, tokens.spacing.xs, tokens.spacing.xs / 2),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.only(
          bottomLeft: Radius.circular(tokens.radius.sm),
          topRight: Radius.circular(tokens.radius.sm),
        ),
      ),
      child: Text(
        'preview',
        style: tokens.typography.small
            .copyWith(color: theme.colorScheme.onSurfaceVariant),
      ),
    ),
  );
  return Tooltip(
    message: kDemoTooltip,
    child: Stack(
      clipBehavior: Clip.none,
      children: [child, badge],
    ),
  );
}
