import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `button` (§8.3): `label`, `style: primary|secondary|danger|text`,
/// `action?`, `icon?`, `confirm?`.
///
/// A button without an `action` renders disabled. With `confirm` set, a
/// confirmation dialog (confirm/cancel) opens first and the action is
/// dispatched only on confirm. A missing `label` degrades to a visible
/// placeholder.
Widget buildButton(BuildContext context, UiNode node, RenderContext ctx) {
  final label = node.stringProp('label');
  if (label == null) {
    return degradedBox(context, 'Missing label');
  }
  final style = node.stringProp('style') ?? 'primary';
  final icon = iconFor(node.stringProp('icon'));
  final action = asMap(node.props['action']);
  final confirm = node.stringProp('confirm');
  final VoidCallback? onPressed = action == null
      ? null
      : () {
          if (confirm != null && confirm.isNotEmpty) {
            ctx.confirm(confirm, () => ctx.dispatch(action));
          } else {
            ctx.dispatch(action);
          }
        };

  final iconWidget = icon == null ? null : Icon(icon);
  switch (style) {
    case 'secondary':
      return iconWidget == null
          ? OutlinedButton(onPressed: onPressed, child: Text(label))
          : OutlinedButton.icon(
              onPressed: onPressed, icon: iconWidget, label: Text(label));
    case 'danger':
      final danger = ElevatedButton.styleFrom(
          foregroundColor: Theme.of(context).colorScheme.onError,
          backgroundColor: Theme.of(context).colorScheme.error);
      return iconWidget == null
          ? ElevatedButton(
              style: danger, onPressed: onPressed, child: Text(label))
          : ElevatedButton.icon(
              style: danger,
              onPressed: onPressed,
              icon: iconWidget,
              label: Text(label));
    case 'text':
      return iconWidget == null
          ? TextButton(onPressed: onPressed, child: Text(label))
          : TextButton.icon(
              onPressed: onPressed, icon: iconWidget, label: Text(label));
    default:
      return iconWidget == null
          ? ElevatedButton(onPressed: onPressed, child: Text(label))
          : ElevatedButton.icon(
              onPressed: onPressed, icon: iconWidget, label: Text(label));
  }
}
