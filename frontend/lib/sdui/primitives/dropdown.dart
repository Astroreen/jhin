import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `dropdown` (§8.3): `id`, `items: [{label, value}]`, `value?`, `action?`.
///
/// Writes the selected item's `value` (not its label) into the screen's
/// `UiState` under `id` and optionally dispatches `action` on change. A
/// missing `id` or `items` degrades to a visible placeholder.
Widget buildDropdown(BuildContext context, UiNode node, RenderContext ctx) {
  final id = node.id;
  if (id == null) {
    return degradedBox(context, 'Missing id');
  }
  final items = <DropdownMenuItem<Object?>>[];
  for (final raw in node.listProp('items') ?? const []) {
    final map = asMap(raw);
    if (map == null) continue;
    items.add(DropdownMenuItem<Object?>(
      value: map['value'],
      child: Text('${map['label'] ?? map['value'] ?? ''}'),
    ));
  }
  if (items.isEmpty) {
    return degradedBox(context, 'Missing items');
  }
  final current = fieldValue(ctx, node);
  final action = asMap(node.props['action']);
  return DropdownButtonFormField<Object?>(
    initialValue: current,
    items: items,
    decoration: InputDecoration(labelText: node.stringProp('label')),
    onChanged: (value) {
      ctx.setState(id, value);
      if (action != null) ctx.dispatch(action);
    },
  );
}
