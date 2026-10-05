import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `banner` (§2.6): `content` (node), `actions` (node array), `onDismiss`
/// (action).
///
/// A MaterialBanner-style persistent notice: the content and the action
/// nodes render in a row. When `onDismiss` is set a dismiss affordance is
/// shown (hidden without it — the `chip.onDeleted` precedent); dismissing
/// dispatches `onDismiss` through the same confirm-gate as the §2.3 gesture
/// wrapper (the node's `confirm`, when set) and then removes the banner
/// from the tree. Missing content degrades to a visible placeholder.
///
/// T87: `glass: true` renders the upstream `alert-glass` treatment
/// (index.css:344-374) — the backdrop blurred and saturated, the
/// background fill at the glass opacity. T89: `glassTint` is the upstream
/// `--alert-glass-tint` — the tint colour painted as a 4% wash over the
/// glass fill (the server picks the variant token: destructive for error,
/// info, success, warning).
Widget buildBanner(BuildContext context, UiNode node, RenderContext ctx) =>
    _Banner(node: node, ctx: ctx);

class _Banner extends StatefulWidget {
  const _Banner({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_Banner> createState() => _BannerState();
}

class _BannerState extends State<_Banner> {
  bool _visible = true;

  @override
  Widget build(BuildContext context) {
    if (!_visible) return const SizedBox.shrink();
    final node = widget.node;
    final ctx = widget.ctx;
    final content = buildChildProp(context, ctx, node.props['content']);
    final actions = <Widget>[];
    for (final raw in node.listProp('actions') ?? const <Object?>[]) {
      final widget = buildChildProp(context, ctx, raw);
      if (widget != null) actions.add(widget);
    }
    final onDismiss = asMap(node.props['onDismiss']);
    final design = JhinDesignScope.of(context);
    final tokens = design.tokens;
    final brightness = Theme.brightnessOf(context);
    final row = Padding(
      padding: insetAll(tokens.spacing.md),
      child: Row(
        children: [
          Expanded(child: content ?? degradedBox(context, 'Missing content')),
          ...actions,
          if (onDismiss != null)
            IconButton(
              icon: const Icon(Icons.close),
              tooltip: 'Dismiss',
              visualDensity: VisualDensity.compact,
              onPressed: () {
                final confirm = node.stringProp('confirm');
                if (confirm != null && confirm.isNotEmpty) {
                  ctx.confirm(confirm, () {
                    ctx.dispatch(onDismiss);
                    if (mounted) setState(() => _visible = false);
                  });
                } else {
                  ctx.dispatch(onDismiss);
                  setState(() => _visible = false);
                }
              },
            ),
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
        child: row,
      );
    }
    return Material(
      color: JhinDesignScope.materialOf(context)
          .colorScheme.surfaceContainerHighest,
      child: row,
    );
  }
}
