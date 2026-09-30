import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `checkbox` (§8.3): `id`, `label`, `value?`.
///
/// Writes its checked state into the screen's `UiState` under `id`. A
/// missing `id` degrades to a visible placeholder.
Widget buildCheckbox(BuildContext context, UiNode node, RenderContext ctx) {
  final id = node.id;
  if (id == null) {
    return degradedBox(context, 'Missing id');
  }
  return CheckboxListTile(
    value: fieldValue(ctx, node) == true,
    title: Text(node.stringProp('label') ?? ''),
    onChanged: (value) => ctx.setState(id, value == true),
  );
}
