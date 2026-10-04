import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `nav` (§2.6): `kind: tabs|bottom|drawer|rail|sidebar`,
/// `items: [{label, icon?, screen?, action?, badge?, count?, section?,
/// enabled?}]`, `activeIndex?`, `activeId?`.
///
/// `activeId` highlights the item whose `id` matches and wins over
/// `activeIndex`; a miss falls back to `activeIndex` (or 0) and never
/// crashes. Items without a string `label` are dropped (malformed items
/// degrade); an item with `enabled: false` renders muted and dispatches
/// nothing. An item's `action` dispatches on tap, else its `screen`
/// navigates. The `sidebar` kind groups items under their `section`
/// labels and renders each group as a collapsible shelf (`collapsible` /
/// `collapsed`, on the section's first item or on the nav node). With no
/// usable items the node degrades to a visible placeholder.
Widget buildNav(BuildContext context, UiNode node, RenderContext ctx) =>
    _NavView(node: node, ctx: ctx);

class _NavItem {
  const _NavItem({
    required this.label,
    this.icon,
    this.screen,
    this.action,
    this.badge,
    this.count,
    this.section,
    this.id,
    this.collapsible,
    this.collapsed,
    this.enabled = true,
  });

  final String label;
  final IconData? icon;
  final String? screen;
  final Map<String, dynamic>? action;
  final UiNode? badge;
  final num? count;
  final String? section;
  final String? id;
  final bool? collapsible;
  final bool? collapsed;
  final bool enabled;
}

List<_NavItem> _parseItems(UiNode node) {
  final items = <_NavItem>[];
  for (final raw in node.listProp('items') ?? const []) {
    final map = asMap(raw);
    final label = map?['label'];
    if (label is! String) continue;
    items.add(_NavItem(
      label: label,
      icon: iconFor(map?['icon'] is String ? map!['icon'] as String : null),
      screen: map?['screen'] is String ? map!['screen'] as String : null,
      action: asMap(map?['action']),
      badge: map?['badge'] is Map ? UiNode.fromJson(map!['badge']) : null,
      count: map?['count'] is num ? map!['count'] as num : null,
      section: map?['section'] is String ? map!['section'] as String : null,
      id: map?['id'] is String ? map!['id'] as String : null,
      collapsible: map?['collapsible'] is bool ? map!['collapsible'] as bool : null,
      collapsed: map?['collapsed'] is bool ? map!['collapsed'] as bool : null,
      enabled: map?['enabled'] is bool ? map!['enabled'] as bool : true,
    ));
  }
  return items;
}

/// The highlighted item: `activeId` when it names an item, `activeIndex`
/// (or 0) after a miss, `activeIndex` when it is set, and none when neither
/// prop is present (the §2.6 defaults); every miss degrades instead of
/// throwing.
int? _resolveActive(UiNode node, List<_NavItem> items) {
  final activeId = node.stringProp('activeId');
  if (activeId != null) {
    final byId = items.indexWhere((item) => item.id == activeId);
    if (byId >= 0) return byId;
    return (node.numProp('activeIndex')?.toInt() ?? 0)
        .clamp(0, items.length - 1);
  }
  final byIndex = node.numProp('activeIndex');
  return byIndex?.toInt().clamp(0, items.length - 1);
}

class _NavView extends StatefulWidget {
  const _NavView({required this.node, required this.ctx});

  final UiNode node;
  final RenderContext ctx;

  @override
  State<_NavView> createState() => _NavViewState();
}

class _NavViewState extends State<_NavView> {
  final Map<String, bool> _shelfCollapsed = {};

  void _onTap(_NavItem item) {
    if (!item.enabled) return;
    final action = item.action;
    if (action != null) {
      widget.ctx.dispatch(action);
    } else if (item.screen != null) {
      widget.ctx.navigate(item.screen!);
    }
  }

  Widget? _trailing(_NavItem item) {
    if (item.badge != null) {
      return widget.ctx.build(context, item.badge!);
    }
    if (item.count != null) {
      return Text(
        '${item.count}',
        style: TextStyle(color: JhinDesignScope.materialOf(context).colorScheme.onSurfaceVariant),
      );
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final node = widget.node;
    final items = _parseItems(node);
    if (items.isEmpty) {
      return degradedBox(context, 'Missing items');
    }
    final kind = node.stringProp('kind') ?? 'tabs';
    final active = _resolveActive(node, items);
    // A transparent [Material] keeps tiles and ink targets usable on hosts
    // that do not sit on a Material surface themselves (§2.3 gesture note).
    return Material(
      type: MaterialType.transparency,
      child: switch (kind) {
        'drawer' => _drawer(context, items, active),
        'rail' => _rail(context, items, active),
        'sidebar' => _sidebar(context, node, items, active),
        'bottom' when items.length >= 2 => _bottom(context, items, active),
        _ => _tabs(context, items, active),
      },
    );
  }

  Widget _tabs(BuildContext context, List<_NavItem> items, int? active) {
    final scheme = JhinDesignScope.materialOf(context).colorScheme;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (var i = 0; i < items.length; i++)
            items[i].icon == null
                ? TextButton(
                    onPressed: items[i].enabled ? () => _onTap(items[i]) : null,
                    style: i == active
                        ? TextButton.styleFrom(foregroundColor: scheme.primary)
                        : null,
                    child: Text(
                      items[i].label,
                      style: i == active
                          ? const TextStyle(fontWeight: FontWeight.w600)
                          : null,
                    ),
                  )
                : TextButton.icon(
                    onPressed: items[i].enabled ? () => _onTap(items[i]) : null,
                    style: i == active
                        ? TextButton.styleFrom(foregroundColor: scheme.primary)
                        : null,
                    icon: Icon(items[i].icon),
                    label: Text(
                      items[i].label,
                      style: i == active
                          ? const TextStyle(fontWeight: FontWeight.w600)
                          : null,
                    ),
                  ),
        ],
      ),
    );
  }

  Widget _bottom(BuildContext context, List<_NavItem> items, int? active) {
    return BottomNavigationBar(
      type: BottomNavigationBarType.fixed,
      currentIndex: active ?? 0,
      items: [
        for (final item in items)
          BottomNavigationBarItem(
            icon: item.count == null
                ? Icon(item.icon ?? iconFor('circle_outlined'))
                : Badge(
                    label: Text('${item.count}'),
                    child: Icon(item.icon ?? iconFor('circle_outlined')),
                  ),
            label: item.label,
          ),
      ],
      onTap: (index) => _onTap(items[index]),
    );
  }

  Widget _drawer(BuildContext context, List<_NavItem> items, int? active) {
    final scheme = JhinDesignScope.materialOf(context).colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < items.length; i++)
          ListTile(
            leading: items[i].icon == null ? null : Icon(items[i].icon),
            title: Text(
              items[i].label,
              style: i == active
                  ? TextStyle(
                      fontWeight: FontWeight.w600,
                      color: scheme.primary,
                    )
                  : items[i].enabled
                      ? null
                      : TextStyle(color: scheme.onSurfaceVariant),
            ),
            trailing: _trailing(items[i]),
            enabled: items[i].enabled,
            selected: i == active,
            onTap: items[i].enabled ? () => _onTap(items[i]) : null,
          ),
      ],
    );
  }

  Widget _rail(BuildContext context, List<_NavItem> items, int? active) {
    return NavigationRail(
      selectedIndex: active ?? 0,
      destinations: [
        for (final item in items)
          NavigationRailDestination(
            icon: item.count == null
                ? Icon(item.icon ?? iconFor('circle_outlined'))
                : Badge(
                    label: Text('${item.count}'),
                    child: Icon(item.icon ?? iconFor('circle_outlined')),
                  ),
            label: Text(item.label),
          ),
      ],
      onDestinationSelected: (index) => _onTap(items[index]),
    );
  }

  Widget _sidebar(
    BuildContext context,
    UiNode node,
    List<_NavItem> items,
    int? active,
  ) {
    final scheme = JhinDesignScope.materialOf(context).colorScheme;
    final tokens = JhinDesignScope.of(context).tokens;
    final groups = <String, List<_NavItem>>{};
    for (final item in items) {
      groups.putIfAbsent(item.section ?? '', () => []).add(item);
    }
    final children = <Widget>[];
    groups.forEach((key, group) {
      final first = group.first;
      final section = first.section;
      final collapsible = first.collapsible ?? node.boolProp('collapsible') == true;
      final initiallyCollapsed =
          first.collapsed ?? node.boolProp('collapsed') == true;
      final collapsed = _shelfCollapsed[key] ?? initiallyCollapsed;
      if (section != null) {
        children.add(InkWell(
          onTap: collapsible
              ? () => setState(() => _shelfCollapsed[key] = !collapsed)
              : null,
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: tokens.spacing.md,
              vertical: tokens.spacing.sm,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    section,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.4,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
                if (collapsible)
                  Icon(
                    collapsed ? Icons.expand_more : Icons.expand_less,
                    size: 18,
                    color: scheme.onSurfaceVariant,
                  ),
              ],
            ),
          ),
        ));
      }
      if (collapsed) return;
      for (var i = 0; i < group.length; i++) {
        final item = group[i];
        final index = items.indexOf(item);
        children.add(ListTile(
          leading: item.icon == null ? null : Icon(item.icon),
          title: Text(
            item.label,
            style: index == active
                ? TextStyle(
                    fontWeight: FontWeight.w600,
                    color: scheme.primary,
                  )
                : item.enabled
                    ? null
                    : TextStyle(color: scheme.onSurfaceVariant),
          ),
          trailing: _trailing(item),
          enabled: item.enabled,
          selected: index == active,
          onTap: item.enabled ? () => _onTap(item) : null,
        ));
      }
    });
    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}
