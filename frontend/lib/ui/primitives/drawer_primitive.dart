import 'package:flutter/material.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `drawer` — компактная боковая панель: title? + children.
/// MVP: styled-контейнер с иконкой и заголовком (без overlay/выезда).
Widget buildDrawer(Map<String, dynamic> json, UiContext ctx) {
  final title = asString(json['title']);
  final children = buildChildWidgets(json['children'], ctx);
  return Container(
    width: double.infinity,
    margin: const EdgeInsets.symmetric(vertical: 4),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFFF2F2F7),
      borderRadius: const BorderRadius.horizontal(right: Radius.circular(10)),
      border: const Border(
        left: BorderSide(color: Color(0xFF5B6CFF), width: 4),
      ),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.menu, size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                title ?? '',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ...children,
      ],
    ),
  );
}
