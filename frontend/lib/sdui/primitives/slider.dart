import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `slider` (§8.3): `id`, `label?`, `min`, `max`, `step?`, `value?`.
///
/// Writes the selected double into the screen's `UiState` under `id`. A
/// missing `id` degrades to a visible placeholder; missing `min`/`max`
/// fall back to 0/1 so the control stays usable.
Widget buildSlider(BuildContext context, UiNode node, RenderContext ctx) {
  final id = node.id;
  if (id == null) {
    return degradedBox(context, 'Missing id');
  }
  final min = node.numProp('min')?.toDouble() ?? 0;
  final max = node.numProp('max')?.toDouble() ?? 1;
  final step = node.numProp('step')?.toDouble();
  final raw = fieldValue(ctx, node);
  final value = (raw is num ? raw.toDouble() : min).clamp(min, max);
  final label = node.stringProp('label');
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (label != null && label.isNotEmpty) Text(label),
      Slider(
        value: value,
        min: min,
        max: max,
        divisions:
            step == null || step <= 0 ? null : ((max - min) / step).round(),
        onChanged: (next) => ctx.setState(id, next),
      ),
    ],
  );
}
