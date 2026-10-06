import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `tabs` (§2.6): `items: [{label, icon?, badge?, panel?, closable?,
/// closeAction?}]`, `activeIndex?` (default 0, patchable via the node `id`),
/// `variant: underline|pill|segmented` (default `underline`), `hasClose?`
/// (T105, default false) and `closeAction?`.
///
/// Switching tabs swaps the visible panel locally; a `patch` frame targeting
/// this node's `id` with `props: {activeIndex: …}` swaps it too. Items
/// without a string `label` are dropped (malformed items degrade); an
/// out-of-range `activeIndex` clamps into the item range. With no usable
/// items the node degrades to a visible placeholder.
///
/// T105: `hasClose: true` renders the upstream panel tab bar — icon + label
/// + a close `X` (the `PanelTabCloseButton`, `size-4` = 16 px hit target).
/// Closing a tab is a client-side `patch` removing it from `items`; the last
/// close runs the node `closeAction` (the panel close). An item marked
/// `closable: false` is a pinned no-op.
Widget buildTabs(BuildContext context, UiNode node, RenderContext ctx) =>
    _TabsView(node: node, ctx: ctx);

class _TabItem {
  const _TabItem({
    required this.label,
    required this.raw,
    this.icon,
    this.badge,
    this.panel,
    this.closable = true,
    this.closeAction,
  });

  final String label;
  final Map<String, dynamic> raw;
  final IconData? icon;
  final UiNode? badge;
  final UiNode? panel;
  final bool closable;
  final Map<String, dynamic>? closeAction;
}

List<_TabItem> _parseItemsFrom(Object? rawItems) {
  final items = <_TabItem>[];
  if (rawItems is! List) return items;
  for (final raw in rawItems) {
    final map = asMap(raw);
    final label = map?['label'];
    if (map == null || label is! String) continue;
    final close = map['closeAction'];
    items.add(_TabItem(
      label: label,
      raw: map,
      icon: iconFor(map['icon'] is String ? map['icon'] as String : null),
      badge: map['badge'] is Map ? UiNode.fromJson(map['badge']) : null,
      panel: map['panel'] is Map ? UiNode.fromJson(map['panel']) : null,
      closable: map['closable'] != false,
      closeAction:
          close is Map ? Map<String, dynamic>.from(close) : null,
    ));
  }
  return items;
}

/// The effective items: the `items` overlay of a `patch` frame when present
/// (the T105 close removes a tab without a server round-trip), else the
/// node's own `items` prop.
List<_TabItem> _effectiveItems(UiNode node, RenderContext ctx) {
  final overlay = node.id == null ? null : ctx.patches[node.id];
  final raw = (overlay != null && overlay.containsKey('items'))
      ? overlay['items']
      : node.props['items'];
  return _parseItemsFrom(raw);
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

  /// Closes one tab (T105): a pinned (`closable: false`) item is a no-op.
  /// Otherwise the item is removed with a client-side `patch` on this node's
  /// `id`; when the last item goes, the node `closeAction` runs (the panel
  /// close) and when the item carries its own `closeAction` that runs too.
  void _close(int index, List<_TabItem> items) {
    if (index < 0 || index >= items.length) return;
    final item = items[index];
    if (!item.closable) return;
    final remaining = <Map<String, dynamic>>[
      for (var i = 0; i < items.length; i++)
        if (i != index) items[i].raw,
    ];
    var next = _active;
    if (index < next) next -= 1;
    if (next >= remaining.length) {
      next = remaining.isEmpty ? 0 : remaining.length - 1;
    }
    setState(() => _active = next);
    final id = widget.node.id;
    if (id != null) {
      widget.ctx.patch(id, {'items': remaining});
    }
    final itemAction = item.closeAction;
    if (itemAction != null) {
      widget.ctx.dispatch(itemAction);
    }
    if (remaining.isEmpty) {
      final nodeClose = widget.node.props['closeAction'];
      if (nodeClose is Map) {
        widget.ctx.dispatch(Map<String, dynamic>.from(nodeClose));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _effectiveItems(widget.node, widget.ctx);
    if (items.isEmpty) {
      return degradedBox(context, 'Missing items');
    }
    final active = _active.clamp(0, items.length - 1);
    final hasClose = widget.node.boolProp('hasClose') == true;
    final Widget bar;
    if (hasClose) {
      bar = _panelBar(context, items, active, _select, _close);
    } else {
      final variant = widget.node.stringProp('variant') ?? 'underline';
      bar = switch (variant) {
        'pill' => _pillBar(context, widget.ctx, items, active, _select),
        'segmented' => _segmentedBar(context, widget.ctx, items, active, _select),
        _ => _underlineBar(context, widget.ctx, items, active, _select),
      };
    }
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
  final scheme = JhinDesignScope.materialOf(context).colorScheme;
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

/// The T105 panel tab bar (`hasClose: true`): the upstream
/// `RightPanelTabs` strip — icon + label + the close `X`, gap 1, `px-3 py-2`
/// inset; the active tab paints `sidebar-row-active`, the inactive label
/// `sidebar-muted-foreground` (`RightPanelTabs.tsx:1109-1114`).
Widget _panelBar(
  BuildContext context,
  List<_TabItem> items,
  int active,
  ValueChanged<int> onSelect,
  void Function(int, List<_TabItem>) onClose,
) {
  final design = JhinDesignScope.of(context);
  final tokens = design.tokens;
  final material = JhinDesignScope.materialOf(context);
  final brightness = Theme.brightnessOf(context);
  final activeBg =
      design.colorOf('sidebar-row-active', brightness: brightness) ??
          material.colorScheme.surfaceContainerHighest;
  final activeFg = design.colorOf('sidebar-foreground', brightness: brightness) ??
      material.colorScheme.onSurface;
  final inactiveFg =
      design.colorOf('sidebar-muted-foreground', brightness: brightness) ??
          material.colorScheme.onSurfaceVariant;
  return SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < items.length; i++) ...[
          if (i > 0) SizedBox(width: tokens.spacing.xs),
          _panelTab(
            context,
            items[i],
            i == active,
            activeBg,
            activeFg,
            inactiveFg,
            () => onSelect(i),
            () => onClose(i, items),
          ),
        ],
      ],
    ),
  );
}

/// One panel tab: the selected fill, the icon + label and the close `X`.
Widget _panelTab(
  BuildContext context,
  _TabItem item,
  bool active,
  Color activeBg,
  Color activeFg,
  Color inactiveFg,
  VoidCallback onSelect,
  VoidCallback onClose,
) {
  final tokens = JhinDesignScope.of(context).tokens;
  final radius = BorderRadius.circular(tokens.radius.md);
  final fg = active ? activeFg : inactiveFg;
  return Material(
    color: active ? activeBg : Colors.transparent,
    borderRadius: radius,
    child: InkWell(
      onTap: onSelect,
      borderRadius: radius,
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: tokens.spacing.md,
          vertical: tokens.spacing.sm,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (item.icon != null) ...[
              Icon(item.icon, size: 14, color: fg),
              SizedBox(width: tokens.spacing.xs),
            ],
            Text(
              item.label,
              style: TextStyle(fontSize: 12, color: fg),
            ),
            _panelClose(fg, item.closable, onClose),
          ],
        ),
      ),
    ),
  );
}

/// The close `X` (the upstream `PanelTabCloseButton`): a `size-4` (16 px) hit
/// target with the `size-3` (12 px) glyph. A pinned (`closable: false`) tab
/// keeps the affordance but the tap is inert (dimmed).
Widget _panelClose(Color fg, bool closable, VoidCallback onClose) {
  return Padding(
    padding: const EdgeInsets.only(left: 4),
    child: InkWell(
      onTap: closable ? onClose : null,
      borderRadius: BorderRadius.circular(2),
      child: SizedBox(
        width: 16,
        height: 16,
        child: Icon(
          Icons.close,
          size: 12,
          color: fg.withValues(alpha: closable ? 1.0 : 0.4),
        ),
      ),
    ),
  );
}

Widget _underlineBar(
  BuildContext context,
  RenderContext ctx,
  List<_TabItem> items,
  int active,
  ValueChanged<int> onSelect,
) {
  final scheme = JhinDesignScope.materialOf(context).colorScheme;
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
  final scheme = JhinDesignScope.materialOf(context).colorScheme;
  final tokens = JhinDesignScope.of(context).tokens;
  return Container(
    padding: insetAll(tokens.spacing.xs),
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
  final scheme = JhinDesignScope.materialOf(context).colorScheme;
  final tokens = JhinDesignScope.of(context).tokens;
  final radius = BorderRadius.circular(tokens.radius.sm);
  return Container(
    padding: insetAll(tokens.spacing.xs),
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