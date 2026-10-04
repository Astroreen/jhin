import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `tabs` (§2.6): `items: [{label, icon?, badge?, panel?}]`, `activeIndex?`
/// (default 0, patchable via the node `id`), `variant: underline|pill|
/// segmented` (default `underline`).
///
/// Switching tabs swaps the visible panel locally; a `patch` frame targeting
/// this node's `id` with `props: {activeIndex: …}` swaps it too. Items
/// without a string `label` are dropped (malformed items degrade); an
/// out-of-range `activeIndex` clamps into the item range. With no usable
/// items the node degrades to a visible placeholder.
Widget buildTabs(BuildContext context, UiNode node, RenderContext ctx) =>
    _TabsView(node: node, ctx: ctx);

class _TabItem {
  const _TabItem({required this.label, this.icon, this.badge, this.panel});

  final String label;
  final IconData? icon;
  final UiNode? badge;
  final UiNode? panel;
}

List<_TabItem> _parseItems(UiNode node) {
  final items = <_TabItem>[];
  for (final raw in node.listProp('items') ?? const []) {
    final map = asMap(raw);
    final label = map?['label'];
    if (label is! String) continue;
    items.add(_TabItem(
      label: label,
      icon: iconFor(map?['icon'] is String ? map!['icon'] as String : null),
      badge: map?['badge'] is Map ? UiNode.fromJson(map!['badge']) : null,
      panel: map?['panel'] is Map ? UiNode.fromJson(map!['panel']) : null,
    ));
  }
  return items;
}

/// The selected tab: the `activeIndex` prop (patch overlays included), the
/// `activeIndex` overlay of a `patch` frame when present, else 0.
int _activeIndex(UiNode node, RenderContext ctx) {
  final overlay = node.id == null ? null : ctx.patches[node.id];
  final raw = overlay != null && overlay.containsKey('activeIndex')
      ? overlay['activeIndex']
      : node.props['activeIndex'];
  return raw is num ? raw.toInt() : 0;
}

class _TabsView extends StatefulWidget {
  const _TabsView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_TabsView> createState() => _TabsViewState();
}

class _TabsViewState extends State<_TabsView> {
  late int _active = _activeIndex(widget.node, widget.ctx);

  @override
  void didUpdateWidget(covariant _TabsView old) {
    super.didUpdateWidget(old);
    final overlay =
        widget.node.id == null ? null : widget.ctx.patches[widget.node.id];
    var next = _active;
    var changed = false;
    if (overlay != null && overlay.containsKey('activeIndex')) {
      next = overlay['activeIndex'] is num
          ? (overlay['activeIndex'] as num).toInt()
          : 0;
      changed = true;
    } else if (widget.node.props['activeIndex'] !=
        old.node.props['activeIndex']) {
      final raw = widget.node.props['activeIndex'];
      next = raw is num ? raw.toInt() : 0;
      changed = true;
    }
    if (changed && next != _active) {
      setState(() => _active = next);
    }
  }

  void _select(int index) {
    setState(() => _active = index);
    final id = widget.node.id;
    if (id != null) {
      widget.ctx.patch(id, {'activeIndex': index});
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _parseItems(widget.node);
    if (items.isEmpty) {
      return degradedBox(context, 'Missing items');
    }
    final active = _active.clamp(0, items.length - 1);
    final variant = widget.node.stringProp('variant') ?? 'underline';
    final bar = switch (variant) {
      'pill' => _pillBar(context, widget.ctx, items, active, _select),
      'segmented' => _segmentedBar(context, widget.ctx, items, active, _select),
      _ => _underlineBar(context, widget.ctx, items, active, _select),
    };
    final panel = items[active].panel;
    // A transparent [Material] keeps the tab targets usable on hosts that
    // do not sit on a Material surface themselves (§2.3 gesture note).
    return Material(
      type: MaterialType.transparency,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          bar,
          if (panel != null) widget.ctx.build(context, panel),
        ],
      ),
    );
  }
}

Widget _label(
  BuildContext context,
  RenderContext ctx,
  _TabItem item,
  bool active,
) {
  final scheme = Theme.of(context).colorScheme;
  return Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (item.icon != null) ...[
        Icon(item.icon, size: 18, color: active ? scheme.primary : null),
        const SizedBox(width: 6),
      ],
      Flexible(
        child: Text(
          item.label,
          style: TextStyle(
            fontWeight: active ? FontWeight.w600 : FontWeight.w400,
            color: active ? scheme.primary : null,
          ),
        ),
      ),
      if (item.badge != null) ...[
        const SizedBox(width: 6),
        ctx.build(context, item.badge!),
      ],
    ],
  );
}

Widget _underlineBar(
  BuildContext context,
  RenderContext ctx,
  List<_TabItem> items,
  int active,
  ValueChanged<int> onSelect,
) {
  final scheme = Theme.of(context).colorScheme;
  final tokens = JhinDesignScope.of(context).tokens;
  return SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < items.length; i++)
          InkWell(
            onTap: () => onSelect(i),
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: tokens.spacing.md,
                vertical: tokens.spacing.sm,
              ),
              decoration: BoxDecoration(
                border: Border(
                  bottom: BorderSide(
                    color: i == active ? scheme.primary : Colors.transparent,
                    width: 2,
                  ),
                ),
              ),
              child: _label(context, ctx, items[i], i == active),
            ),
          ),
      ],
    ),
  );
}

Widget _pillBar(
  BuildContext context,
  RenderContext ctx,
  List<_TabItem> items,
  int active,
  ValueChanged<int> onSelect,
) {
  final scheme = Theme.of(context).colorScheme;
  final tokens = JhinDesignScope.of(context).tokens;
  return Container(
    padding: EdgeInsets.all(tokens.spacing.xs),
    decoration: BoxDecoration(
      color: scheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(tokens.radius.lg),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < items.length; i++)
          InkWell(
            onTap: () => onSelect(i),
            borderRadius: BorderRadius.circular(tokens.radius.lg),
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: tokens.spacing.md,
                vertical: tokens.spacing.sm,
              ),
              decoration: i == active
                  ? BoxDecoration(
                      color: scheme.primary,
                      borderRadius: BorderRadius.circular(tokens.radius.lg),
                    )
                  : null,
              child: _label(context, ctx, items[i], i == active),
            ),
          ),
      ],
    ),
  );
}

Widget _segmentedBar(
  BuildContext context,
  RenderContext ctx,
  List<_TabItem> items,
  int active,
  ValueChanged<int> onSelect,
) {
  final scheme = Theme.of(context).colorScheme;
  final tokens = JhinDesignScope.of(context).tokens;
  final radius = BorderRadius.circular(tokens.radius.sm);
  return Container(
    padding: EdgeInsets.all(tokens.spacing.xs),
    decoration: BoxDecoration(
      border: Border.all(color: scheme.outline),
      borderRadius: radius,
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < items.length; i++)
          InkWell(
            onTap: () => onSelect(i),
            borderRadius: radius,
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: tokens.spacing.md,
                vertical: tokens.spacing.sm,
              ),
              decoration: i == active
                  ? BoxDecoration(color: scheme.primary, borderRadius: radius)
                  : null,
              child: _label(context, ctx, items[i], i == active),
            ),
          ),
      ],
    ),
  );
}