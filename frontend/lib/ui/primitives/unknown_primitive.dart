import 'package:flutter/material.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// Неизвестный тип → карточка-заглушка с иконкой, без падений.
Widget buildUnsupported(Map<String, dynamic> json, UiContext ctx) {
  final type = asString(json['type']) ?? '';
  return Card(
    margin: const EdgeInsets.symmetric(vertical: 4),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          const Icon(Icons.help_outline, size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text('Unsupported UI element: $type')),
        ],
      ),
    ),
  );
}
