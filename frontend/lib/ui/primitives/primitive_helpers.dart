import 'package:flutter/widgets.dart';

import '../renderer/ui_renderer.dart';
import '../ui_context.dart';

/// Безопасные приведения JSON-полей: любой кривой вход → мягкий деград
/// (null/пустое/дефолт), никаких exception наверх.
Map<String, dynamic>? asJsonMap(dynamic value) {
  if (value is Map) {
    return Map<String, dynamic>.from(value);
  }
  return null;
}

/// Список JSON-узлов; не-список → пустой список.
List<dynamic> asJsonList(dynamic value) {
  if (value is List) {
    return value;
  }
  return const [];
}

/// Строка как есть; не-строка → null (числа НЕ конвертируем — это данные).
String? asString(dynamic value) => value is String ? value : null;

/// Строка для отображения; null/не-строка → пустая строка.
String asText(dynamic value) => value is String ? value : '';

/// Число → double; мусор → null.
double? asDouble(dynamic value) {
  if (value is num) {
    return value.toDouble();
  }
  if (value is String) {
    return double.tryParse(value);
  }
  return null;
}

/// Булево значение; мусор → null.
bool? asBool(dynamic value) => value is bool ? value : null;

/// Hex-цвет (`#RRGGBB`, `#AARRGGBB`, `RRGGBB`, `0xFFRRGGBB`) или int.
/// Кривой ввод → null (примитив берёт свой дефолт).
Color? parseHexColor(dynamic value) {
  if (value is num) {
    final v = value.toInt();
    if (v < 0 || v > 0xFFFFFFFF) {
      return null;
    }
    return Color(v);
  }
  if (value is! String) {
    return null;
  }
  var s = value.trim();
  if (s.isEmpty) {
    return null;
  }
  if (s.startsWith('#')) {
    s = s.substring(1);
  } else if (s.startsWith('0x') || s.startsWith('0X')) {
    s = s.substring(2);
  }
  if (s.length == 6) {
    final v = int.tryParse(s, radix: 16);
    return v == null ? null : Color(0xFF000000 | v);
  }
  if (s.length == 8) {
    final v = int.tryParse(s, radix: 16);
    return v == null ? null : Color(v);
  }
  return null;
}

/// Рекурсивный рендер массива `children` (UI-узлы или строки).
List<Widget> buildChildWidgets(dynamic children, UiContext ctx) {
  return asJsonList(children).map((node) => buildChildWidget(node, ctx)).toList();
}

/// Один дочерний узел: Map → [buildUi] (рекурсия), String → Text, иначе пусто.
Widget buildChildWidget(dynamic node, UiContext ctx) {
  if (node is Map) {
    return buildUi(Map<String, dynamic>.from(node), ctx);
  }
  if (node is String) {
    return Text(node);
  }
  return const SizedBox.shrink();
}
