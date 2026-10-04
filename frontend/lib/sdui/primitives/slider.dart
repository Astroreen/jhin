import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `slider` (§2.6): `id`, `label?`, `min`, `max`, `step?`, `value?` plus the
/// full slider parity (`activeColor`, `inactiveColor`, `thumbColor`,
/// `overlayColor`, `mouseCursor`, `onChangeStart`, `onChangeEnd`,
/// `semanticFormatterCallback`).
///
/// Writes the selected double into the screen's `UiState` under `id`; the
/// drag-boundary actions fire with the value merged into their payload. A
/// missing `id` degrades to a visible placeholder; missing `min`/`max` fall
/// back to 0/1 so the control stays usable.
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
  final formatter = node.stringProp('semanticFormatterCallback');
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
        label: label,
        activeColor: parseColor(node.props['activeColor']),
        inactiveColor: parseColor(node.props['inactiveColor']),
        thumbColor: parseColor(node.props['thumbColor']),
        overlayColor: _overlayColor(node.props['overlayColor']),
        mouseCursor: parseMouseCursor(node.stringProp('mouseCursor')),
        semanticFormatterCallback: formatter == null
            ? null
            : (value) => formatter.replaceAll('{value}', _number(value)),
        onChangeStart: _dragAction(node, ctx, 'onChangeStart'),
        onChangeEnd: _dragAction(node, ctx, 'onChangeEnd'),
        onChanged: (next) => ctx.setState(id, next),
      ),
    ],
  );
}

String _number(double value) =>
    value == value.roundToDouble() ? value.round().toString() : value.toString();

WidgetStateProperty<Color?>? _overlayColor(Object? value) {
  final color = parseColor(value);
  return color == null ? null : WidgetStatePropertyAll(color);
}

ValueChanged<double>? _dragAction(UiNode node, RenderContext ctx, String key) {
  final action = asMap(node.props[key]);
  if (action == null) return null;
  return (value) {
    final payload = <String, dynamic>{};
    final staticPayload = action['payload'];
    if (staticPayload is Map) {
      payload.addAll(Map<String, dynamic>.from(staticPayload));
    }
    payload['value'] = value;
    ctx.dispatch({
      ...action,
      'payload': payload,
    });
  };
}
