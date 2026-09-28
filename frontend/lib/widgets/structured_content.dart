import 'dart:convert';

import 'package:flutter/material.dart';

import '../ui/renderer/ui_renderer.dart';
import '../ui/ui_context.dart';

/// T30 ExtensionPoint: рендер `structured` content tool-результатов.
///
/// Если structured — Map с полем `type` → server-driven UI через [buildUi]
/// (реестр примитивов); иначе — прежний JSON в моноширинном блоке.
///
/// [sessionId] и [onAction] (опционально) — контекст ui-action кнопок/форм;
/// без них действия SDUI — no-op (T32+ подключает `api.sendUiAction`).
Widget buildStructured(
  dynamic structured, {
  String sessionId = '',
  UiActionCallback? onAction,
}) {
  if (structured == null) {
    return const SizedBox.shrink();
  }
  if (structured is Map) {
    try {
      final map = Map<String, dynamic>.from(structured);
      if (map['type'] is String) {
        final ctx = UiContext(
          sessionId: sessionId,
          onAction: onAction ?? (action, payload) {},
        );
        return buildUi(map, ctx);
      }
    } catch (_) {
      // кривой Map (не-строковые ключи) → JSON-фолбэк ниже
    }
  }
  String text;
  try {
    text = const JsonEncoder.withIndent('  ').convert(structured);
  } on JsonUnsupportedObjectError {
    text = structured.toString();
  }
  return Container(
    width: double.infinity,
    padding: const EdgeInsets.all(8),
    decoration: BoxDecoration(
      color: Colors.grey.shade100,
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      text,
      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
    ),
  );
}
