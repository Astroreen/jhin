import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `checkbox` (§2.6): `id`, `label`, `value?` plus the full checkbox parity
/// (`tristate`, `fillColor` with the selected/hover/focus/disabled state
/// colors, `mouseCursor`, `splashRadius`, `dense`).
///
/// Writes its checked state into the screen's `UiState` under `id`. A
/// missing `id` degrades to a visible placeholder; unknown props degrade
/// silently (§2.4) — `thumbIcon`/`trackColor` have no Checkbox counterpart
/// in Flutter and are accepted and ignored.
Widget buildCheckbox(BuildContext context, UiNode node, RenderContext ctx) {
  final id = node.id;
  if (id == null) {
    return degradedBox(context, 'Missing id');
  }
  final tristate = node.boolProp('tristate') == true;
  final raw = fieldValue(ctx, node);
  return CheckboxListTile(
    value: raw is bool ? raw : (tristate ? null : false),
    tristate: tristate,
    title: Text(node.stringProp('label') ?? ''),
    fillColor: fillColorStates(
      fillColor: parseColor(node.props['fillColor']),
      hoverColor: parseColor(node.props['hoverColor']),
      focusColor: parseColor(node.props['focusColor']),
      disabledColor: parseColor(node.props['disabledColor']),
    ),
    hoverColor: parseColor(node.props['hoverColor']),
    mouseCursor: parseMouseCursor(node.stringProp('mouseCursor')),
    splashRadius: node.numProp('splashRadius')?.toDouble(),
    dense: node.boolProp('dense'),
    onChanged: (value) => ctx.setState(id, tristate ? value : value == true),
  );
}

/// Resolves the checkbox `fillColor` across its selected/hover/focus/
/// disabled states (§2.6) from the flat color keys; null when none is set.
WidgetStateProperty<Color?>? fillColorStates({
  Color? fillColor,
  Color? hoverColor,
  Color? focusColor,
  Color? disabledColor,
}) {
  if (fillColor == null && hoverColor == null && focusColor == null && disabledColor == null) {
    return null;
  }
  return WidgetStateProperty.resolveWith((states) {
    if (states.contains(WidgetState.disabled)) return disabledColor ?? fillColor;
    if (states.contains(WidgetState.selected)) return fillColor;
    if (states.contains(WidgetState.hovered)) return hoverColor ?? fillColor;
    if (states.contains(WidgetState.focused)) return focusColor ?? fillColor;
    return fillColor;
  });
}
