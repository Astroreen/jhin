import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `menu` (§2.6): `trigger` (node), `items` (item array), `breakpoint` (num,
/// default 900).
///
/// Tapping the trigger opens a `PopupMenuButton` over the item list; below
/// `breakpoint` (or 900 when unset) the same items open as a modal bottom
/// sheet. Each item is `{label, icon?, action?, confirm?, disabled?, divider?,
/// danger?}` (§2.6): `divider: true` renders a `Divider` entry, `disabled`
/// dispatches nothing, `danger` paints the label in the scheme error color
/// and `confirm` gates the dispatch through `RenderContext.confirm` (a
/// decline dispatches nothing) — the same confirm-gate the §2.3 gesture
/// wrapper uses. A string item promotes to `{label: …}`. The trigger is
/// wrapped in `AbsorbPointer` so its own `action`/`onTap` handlers cannot
/// swallow the tap — the trigger's tap opens the menu — and the `menu` node
/// itself is in the `_interactivePrimitives` set (its universal `action` is
/// not wired to a tap; item actions are). With no items the trigger renders
/// without a popup.
Widget buildMenu(BuildContext context, UiNode node, RenderContext ctx) {
  final trigger = buildChildProp(context, ctx, node.props['trigger']);
  if (trigger == null) {
    return degradedBox(context, 'Missing trigger');
  }
  final items = <Map<String, dynamic>>[];
  for (final raw in node.listProp('items') ?? const <Object?>[]) {
    if (raw is String) {
      items.add({'label': raw});
      continue;
    }
    final map = asMap(raw);
    if (map != null) items.add(map);
  }
  final guarded = AbsorbPointer(child: trigger);
  if (items.isEmpty) return guarded;

  final breakpoint = node.numProp('breakpoint')?.toDouble() ?? 900;
  final enabled = node.boolProp('enabled') != false;

  void dispatchItem(Map<String, dynamic> item) {
    final action = asMap(item['action']);
    if (action == null) return;
    final confirm = item['confirm'];
    if (confirm is String && confirm.isNotEmpty) {
      ctx.confirm(confirm, () => ctx.dispatch(action));
    } else {
      ctx.dispatch(action);
    }
  }

  List<PopupMenuEntry<int>> popupEntries(BuildContext menuContext) {
    final entries = <PopupMenuEntry<int>>[];
    for (var i = 0; i < items.length; i++) {
      final item = items[i];
      if (item['divider'] == true) {
        entries.add(const PopupMenuDivider());
        continue;
      }
      entries.add(PopupMenuItem<int>(
        value: i,
        enabled: item['disabled'] != true,
        child: _menuItemRow(menuContext, item),
      ));
    }
    return entries;
  }

  final width = MediaQuery.sizeOf(context).width;
  if (width < breakpoint) {
    return GestureDetector(
      onTap: !enabled
          ? null
          : () {
              showModalBottomSheet<void>(
                context: context,
                builder: (sheetContext) => SafeArea(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (var i = 0; i < items.length; i++)
                        if (items[i]['divider'] == true)
                          const Divider(height: 1)
                        else
                          ListTile(
                            enabled: items[i]['disabled'] != true,
                            leading: _menuLeadingIcon(items[i]),
                            title: _menuItemRow(sheetContext, items[i]),
                            onTap: () {
                              Navigator.of(sheetContext).pop();
                              dispatchItem(items[i]);
                            },
                          ),
                    ],
                  ),
                ),
              );
            },
      child: guarded,
    );
  }
  return PopupMenuButton<int>(
    enabled: enabled,
    itemBuilder: popupEntries,
    onSelected: (index) => dispatchItem(items[index]),
    child: guarded,
  );
}

/// The optional leading icon of one menu item (null without an `icon` name).
Widget? _menuLeadingIcon(Map<String, dynamic> item) {
  final icon = iconFor(item['icon'] is String ? item['icon'] as String : null);
  return icon == null ? null : Icon(icon, size: 18);
}

/// One menu item row: optional leading icon and the label — in the scheme
/// error color when `danger` is set (§2.6 "destructive styling").
Widget _menuItemRow(BuildContext context, Map<String, dynamic> item) {
  final label = item['label'] is String ? item['label'] as String : '';
  final icon = iconFor(item['icon'] is String ? item['icon'] as String : null);
  final danger = item['danger'] == true;
  final style = danger
      ? TextStyle(color: Theme.of(context).colorScheme.error)
      : null;
  return Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (icon != null) ...[Icon(icon, size: 18), const SizedBox(width: 8)],
      Text(label, style: style),
    ],
  );
}
