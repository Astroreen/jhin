import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'icon.dart';

/// `dropdown` (§2.6): `id`, `items: [{label, value}]`, `value?`, `action?`
/// plus the full dropdown parity (`hint`, `isExpanded`, `isDense`,
/// `elevation`, `icon`, `iconSize`, `alignment`, `borderRadius`,
/// `itemHeight`, `selectedItemBuilder`, `menuMaxHeight`, `focusColor`,
/// `dropdownColor`).
///
/// Writes the selected item's `value` (not its label) into the screen's
/// `UiState` under `id` and optionally dispatches `action` on change. A
/// missing `id` or `items` degrades to a visible placeholder; unknown enum
/// literals degrade to the prop's default (§2.4).
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
  // Universal `enabled: false` (§2.1) drops the change interaction — the
  // field keeps its layout and renders disabled.
  final enabled = node.boolProp('enabled') != false;
  final rawIcon = node.stringProp('icon');
  final rawIconSize = node.numProp('iconSize')?.toDouble();
  final rawElevation = node.numProp('elevation')?.toDouble();
  final rawRadius = node.numProp('borderRadius')?.toDouble();
  final rawItemHeight = node.numProp('itemHeight')?.toDouble();
  final rawMenuMaxHeight = node.numProp('menuMaxHeight')?.toDouble();
  final hint = node.stringProp('hint');
  // The Flutter field asserts that the selected value exists among the
  // items; a server value that misses them degrades to the unselected state
  // instead of crashing (§2.4).
  final values = {for (final item in items) item.value};
  final selected = current != null && values.contains(current) ? current : null;
  return DropdownButtonFormField<Object?>(
    initialValue: selected,
    items: items,
    hint: hint == null ? null : Text(hint),
    isExpanded: node.boolProp('isExpanded') == true,
    isDense: node.boolProp('isDense') == true,
    elevation: rawElevation?.round() ?? 8,
    icon: rawIcon == null ? null : buildIconValue(context, ctx, rawIcon),
    iconSize: rawIconSize ?? 24.0,
    alignment: parseAlignmentLiteral(node.props['alignment']) ??
        AlignmentDirectional.centerStart,
    borderRadius: rawRadius == null ? null : BorderRadius.circular(rawRadius),
    itemHeight: rawItemHeight,
    selectedItemBuilder: _selectedItemBuilder(context, ctx, node),
    menuMaxHeight: rawMenuMaxHeight,
    focusColor: parseColor(node.props['focusColor']),
    dropdownColor: parseColor(node.props['dropdownColor']),
    decoration: InputDecoration(
      labelText: node.stringProp('label'),
    ),
    onChanged: !enabled
        ? null
        : (value) {
            ctx.setState(id, value);
            if (action != null) ctx.dispatch(action);
          },
  );
}

/// The `selectedItemBuilder` node array (§2.6): custom rendering for the
/// closed state. Nodes are built through the registry; a malformed entry
/// degrades to its text.
DropdownButtonBuilder? _selectedItemBuilder(
  BuildContext context,
  RenderContext ctx,
  UiNode node,
) {
  final raw = node.listProp('selectedItemBuilder');
  if (raw == null || raw.isEmpty) return null;
  return (BuildContext context) => [
        for (final entry in raw)
          if (asMap(entry) != null)
            ctx.build(context, UiNode.fromJson(entry))
          else
            Text('$entry'),
      ];
}
