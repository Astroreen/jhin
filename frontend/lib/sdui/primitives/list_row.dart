import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `list_row` (§2.6): `leading`, `title`, `subtitle`, `trailing`, `badge`,
/// `selected`, `dragHandle`. `title`/`subtitle` accept a node or the string
/// shorthand.
///
/// `action`/`onLongPress` come from the universal Interaction cluster (§2.1)
/// but dispatch through the row's own `InkWell` — the §2.3 gesture wrapper
/// for this primitive — so the registry wrapper is skipped for `list_row`
/// and a tap fires `action` exactly once while a long press fires only
/// `onLongPress`. `selected` paints the tint; `dragHandle` is the visual
/// drag affordance (reorder itself goes through actions).
Widget buildListRow(BuildContext context, UiNode node, RenderContext ctx) {
  final tokens = JhinDesignScope.of(context).tokens;
  final theme = JhinDesignScope.materialOf(context);
  final leading = buildChildProp(context, ctx, node.props['leading']);
  final title = buildChildProp(context, ctx, node.props['title']);
  final subtitle = buildChildProp(context, ctx, node.props['subtitle']);
  final trailing = buildChildProp(context, ctx, node.props['trailing']);
  final badge = buildChildProp(context, ctx, node.props['badge']);
  final selected = node.boolProp('selected') == true;
  final dragHandle = node.boolProp('dragHandle') == true;
  final enabled = node.boolProp('enabled') != false;
  final action = asMap(node.props['action']) ?? asMap(node.props['onTap']);
  final longPressAction = asMap(node.props['onLongPress']);

  final row = Row(
    children: [
      if (leading != null) ...[
        leading,
        SizedBox(width: tokens.spacing.md),
      ],
      Expanded(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ?title,
            ?subtitle,
          ],
        ),
      ),
      if (badge != null) ...[
        SizedBox(width: tokens.spacing.sm),
        badge,
      ],
      if (trailing != null) ...[
        SizedBox(width: tokens.spacing.sm),
        trailing,
      ],
      if (dragHandle) ...[
        SizedBox(width: tokens.spacing.sm),
        const Icon(Icons.drag_handle),
      ],
    ],
  );

  Widget content = Padding(
    padding: EdgeInsets.symmetric(
      horizontal: tokens.spacing.md,
      vertical: tokens.spacing.sm,
    ),
    child: row,
  );
  if (selected) {
    content = ColoredBox(
      color: theme.colorScheme.secondaryContainer,
      child: content,
    );
  }

  if (!enabled || (action == null && longPressAction == null)) return content;

  void dispatch(Map<String, dynamic> act) {
    final confirm = node.stringProp('confirm');
    if (confirm != null && confirm.isNotEmpty) {
      ctx.confirm(confirm, () => ctx.dispatch(act));
    } else {
      ctx.dispatch(act);
    }
  }

  return InkWell(
    onTap: action == null ? null : () => dispatch(action),
    onLongPress: longPressAction == null ? null : () => dispatch(longPressAction),
    hoverColor: theme.hoverColor,
    child: content,
  );
}
