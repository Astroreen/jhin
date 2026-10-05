import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `card` (§8.3): `title?`, `children`.
///
/// With no children the card degrades to a visible placeholder instead of
/// an empty box.
///
/// T87: `glass: true` renders the upstream `surface-glass` treatment
/// (index.css:334-342) — the backdrop blurred by `glass.blur` and
/// saturated by `glass.saturation`, the background fill at `glass.opacity`
/// — instead of the Material card surface. T89: `glassTint` paints the
/// 4% tint wash over the glass fill.
Widget buildCard(BuildContext context, UiNode node, RenderContext ctx) {
  final title = node.stringProp('title');
  final design = JhinDesignScope.of(context);
  final tokens = design.tokens;
  final brightness = Theme.brightnessOf(context);
  final content = Padding(
    padding: insetAll(tokens.spacing.md),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null && title.isNotEmpty)
          Padding(
            padding: EdgeInsets.only(bottom: tokens.spacing.sm),
            child: Text(title,
                style: const TextStyle(fontWeight: FontWeight.bold)),
          ),
        if (node.children.isEmpty)
          degradedBox(context, 'Missing children')
        else
          ...buildChildren(context, node, ctx),
      ],
    ),
  );
  if (node.boolProp('glass') == true) {
    return jhinGlassSurface(
      context,
      surface: tokens.surface,
      fill: design.colorOf('background', brightness: brightness) ??
          JhinDesignScope.materialOf(context).colorScheme.surface,
      borderRadius: jhinSurfaceRadius(
        tokens.surface,
        'xl',
        remPx: design.switches.fontSizes.sizeInterface.toDouble(),
      ),
      tint: glassTintOf(node),
      child: content,
    );
  }
  return Card(child: content);
}
