import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `nav` (§8.3): `kind: tabs|drawer|bottom`, `items: [{label, icon?, screen}]`.
///
/// Every item navigates to its `screen` id through the runtime. Items
/// without a string `label` are dropped (malformed items degrade); an item
/// whose `screen` is not a string renders disabled. With no usable items
/// the node degrades to a visible placeholder.
Widget buildNav(BuildContext context, UiNode node, RenderContext ctx) {
  final kind = node.stringProp('kind') ?? 'tabs';
  final labels = <String>[];
  final screens = <String?>[];
  final icons = <IconData?>[];
  for (final item in node.listProp('items') ?? const []) {
    final map = asMap(item);
    final label = map?['label'];
    if (label is! String) continue;
    labels.add(label);
    screens.add(map?['screen'] is String ? map!['screen'] as String : null);
    icons.add(iconFor(map?['icon'] is String ? map!['icon'] as String : null));
  }
  if (labels.isEmpty) {
    return degradedBox(context, 'Missing items');
  }

  void onTap(int index) {
    final screen = screens[index];
    if (screen != null) ctx.navigate(screen);
  }

  if (kind == 'drawer') {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < labels.length; i++)
          ListTile(
            leading: icons[i] == null ? null : Icon(icons[i]),
            title: Text(labels[i]),
            onTap: screens[i] == null ? null : () => onTap(i),
          ),
      ],
    );
  }
  // BottomNavigationBar asserts at least two items; a lone item degrades
  // to the tab-style buttons instead of killing the node.
  if (kind == 'bottom' && labels.length >= 2) {
    return BottomNavigationBar(
      type: BottomNavigationBarType.fixed,
      currentIndex: 0,
      items: [
        for (var i = 0; i < labels.length; i++)
          BottomNavigationBarItem(
            icon: Icon(icons[i] ?? iconFor('circle_outlined')),
            label: labels[i],
          ),
      ],
      onTap: onTap,
    );
  }
  return SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      children: [
        for (var i = 0; i < labels.length; i++)
          icons[i] == null
              ? TextButton(
                  onPressed: screens[i] == null ? null : () => onTap(i),
                  child: Text(labels[i]),
                )
              : TextButton.icon(
                  onPressed: screens[i] == null ? null : () => onTap(i),
                  icon: Icon(icons[i]),
                  label: Text(labels[i]),
                ),
      ],
    ),
  );
}
