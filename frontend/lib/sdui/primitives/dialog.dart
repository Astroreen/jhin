import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `dialog` (§2.6): `title` (string or node), `content` (node), `actions`
/// (node array).
///
/// An AlertDialog-shaped surface so dialogs are server-authored: the
/// title/content slots and the action buttons render in place, and each
/// action node dispatches through its own handler (a `button` carrying an
/// `action`, §2.4). Every slot is optional — a title with actions and no
/// content is a legal confirm shape. The `dialog` directive (§4) opens this
/// shape modally; an unknown directive `kind` degrades to a `card` render of
/// the content (§2.4).
///
/// T87: `glass: true` renders the upstream `dialog-glass` treatment
/// (index.css:376-390) — the backdrop blurred and saturated, the
/// background fill at the glass opacity, the contrast border at 10%, the
/// outer dialog shadows and (dark) the inset top line — instead of the
/// Material alert surface. The modal backdrop scrim (`dialog-backdrop`,
/// index.css:391-398) rides the `dialog` directive presentation. T89:
/// `glassTint` paints the 4% tint wash over the glass fill.
Widget buildDialog(BuildContext context, UiNode node, RenderContext ctx) {
  final titleProp = node.props['title'];
  final Widget? title = titleProp == null
      ? null
      : titleProp is String
          ? Text(titleProp)
          : buildChildProp(context, ctx, titleProp);
  final content = buildChildProp(context, ctx, node.props['content']);
  final actions = <Widget>[];
  for (final raw in node.listProp('actions') ?? const <Object?>[]) {
    final widget = buildChildProp(context, ctx, raw);
    if (widget != null) actions.add(widget);
  }
  if (node.boolProp('glass') == true) {
    return _glassDialog(context, title, content, actions,
        tint: glassTintOf(node));
  }
  return AlertDialog(
    title: title,
    content: content,
    actions: actions.isEmpty ? null : actions,
  );
}

/// The dialog-glass panel: the [jhinGlassSurface] recipe of
/// `JhinDialogGlassRecipe` over the AlertDialog slot column. [tint] is the
/// T89 `glassTint` wash over the glass fill.
Widget _glassDialog(
  BuildContext context,
  Widget? title,
  Widget? content,
  List<Widget> actions, {
  Color? tint,
}) {
  final design = JhinDesignScope.of(context);
  final tokens = design.tokens;
  final brightness = Theme.brightnessOf(context);
  final scheme = JhinDesignScope.materialOf(context).colorScheme;
  final recipe = JhinDialogGlassRecipe.of(
    tokens.surface,
    brightness,
    background: design.colorOf('background', brightness: brightness) ??
        scheme.surface,
    foreground: design.colorOf('foreground', brightness: brightness) ??
        scheme.onSurface,
  );
  return jhinGlassSurface(
    context,
    surface: tokens.surface,
    fill: recipe.fill,
    borderRadius: jhinSurfaceRadius(
      tokens.surface,
      'xl2',
      remPx: design.switches.fontSizes.sizeInterface.toDouble(),
    ),
    border: Border.all(color: recipe.borderColor),
    shadows: recipe.shadows,
    insetTop: recipe.insetTop,
    tint: tint,
    child: Padding(
      padding: insetAll(tokens.spacing.lg),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null)
            Padding(
              padding: EdgeInsets.only(bottom: tokens.spacing.sm),
              child: title,
            ),
          ?content,
          if (actions.isNotEmpty)
            Padding(
              padding: EdgeInsets.only(top: tokens.spacing.sm),
              child: Align(
                alignment: AlignmentDirectional.centerEnd,
                child: Wrap(
                  alignment: WrapAlignment.end,
                  spacing: tokens.spacing.sm,
                  children: actions,
                ),
              ),
            ),
        ],
      ),
    ),
  );
}
