import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `badge` (§2.6): `label`, `count`, `dot`, `color`, `max` (default 99).
///
/// `dot: true` renders a bare dot with no label; `count` renders the count
/// capped at `max` (`99+` above the cap); otherwise `label` renders. A
/// missing label and count degrades to a visible placeholder.
Widget buildBadge(BuildContext context, UiNode node, RenderContext ctx) {
  final theme = Theme.of(context);
  final color = parseColor(node.props['color']) ?? theme.colorScheme.error;
  if (node.boolProp('dot') == true) {
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
  final count = node.numProp('count');
  final max = node.numProp('max') ?? 99;
  String? text;
  if (count != null) {
    text = count > max ? '${_whole(max)}+' : _whole(count);
  } else {
    text = node.stringProp('label');
  }
  if (text == null || text.isEmpty) {
    return degradedBox(context, 'Missing label');
  }
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Text(
      text,
      style: const TextStyle(
        color: Colors.white,
        fontSize: 12,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

/// A count/max without a trailing `.0` on whole doubles (§2.6 accepts `num`).
String _whole(num value) =>
    value == value.roundToDouble() ? value.toInt().toString() : '$value';
