import 'package:flutter/material.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `button` — label, action, payload?; style (primary|secondary|danger).
/// Tap → `ctx.onAction(action, payload)`; без action — disabled.
Widget buildButton(Map<String, dynamic> json, UiContext ctx) {
  final label = asText(json['label']);
  final action = asString(json['action']);
  final payload = asJsonMap(json['payload']);
  final style = asString(json['style']) ?? 'secondary';

  void onPressed() {
    if (action != null && action.isNotEmpty) {
      ctx.onAction(action, payload);
    }
  }

  final enabled = action != null && action.isNotEmpty;
  final callback = enabled ? onPressed : null;

  return switch (style) {
    'primary' => ElevatedButton(onPressed: callback, child: Text(label)),
    'danger' => Builder(
        builder: (context) {
          final scheme = Theme.of(context).colorScheme;
          return ElevatedButton(
            onPressed: callback,
            style: ElevatedButton.styleFrom(
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
            ),
            child: Text(label),
          );
        },
      ),
    _ => OutlinedButton(onPressed: callback, child: Text(label)),
  };
}
