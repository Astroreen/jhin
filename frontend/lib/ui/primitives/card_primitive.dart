import 'package:flutter/material.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `card` — заголовок (title?) + children в оформленном блоке.
Widget buildCard(Map<String, dynamic> json, UiContext ctx) {
  final title = asString(json['title']);
  final children = buildChildWidgets(json['children'], ctx);
  return Card(
    margin: const EdgeInsets.symmetric(vertical: 4),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) ...[
            Text(
              title,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
          ],
          ...children,
        ],
      ),
    ),
  );
}
