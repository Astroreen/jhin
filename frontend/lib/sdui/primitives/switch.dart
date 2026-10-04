import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `switch` (§2.6): `id`, `label`, `value?` plus the full switch parity
/// (`activeColor`, `activeTrackColor`, `inactiveThumbColor`,
/// `inactiveTrackColor`, `thumbColor`, `trackColor`, `thumbIcon`,
/// `trackOutline`, `mouseCursor`, `splashRadius`, `hoverColor`, `dense`).
///
/// Writes its on/off state into the screen's `UiState` under `id`. A
/// missing `id` degrades to a visible placeholder; unknown props degrade
/// silently (§2.4) — `focusColor` has no SwitchListTile counterpart in
/// Flutter and is accepted and ignored.
Widget buildSwitch(BuildContext context, UiNode node, RenderContext ctx) {
  final id = node.id;
  if (id == null) {
    return degradedBox(context, 'Missing id');
  }
  final rawIcon = node.stringProp('thumbIcon');
  return SwitchListTile(
    value: fieldValue(ctx, node) == true,
    title: Text(node.stringProp('label') ?? ''),
    activeThumbColor: parseColor(node.props['activeColor']),
    activeTrackColor: parseColor(node.props['activeTrackColor']),
    inactiveThumbColor: parseColor(node.props['inactiveThumbColor']),
    inactiveTrackColor: parseColor(node.props['inactiveTrackColor']),
    thumbColor: _stateColor(node.props['thumbColor']),
    trackColor: _stateColor(node.props['trackColor']),
    trackOutlineColor: _stateColor(node.props['trackOutline']),
    thumbIcon: rawIcon == null
        ? null
        : WidgetStatePropertyAll(Icon(iconFor(rawIcon))),
    mouseCursor: parseMouseCursor(node.stringProp('mouseCursor')),
    splashRadius: node.numProp('splashRadius')?.toDouble(),
    hoverColor: parseColor(node.props['hoverColor']),
    dense: node.boolProp('dense'),
    onChanged: (value) => ctx.setState(id, value),
  );
}

WidgetStateProperty<Color?>? _stateColor(Object? value) {
  final color = parseColor(value);
  return color == null ? null : WidgetStatePropertyAll(color);
}
