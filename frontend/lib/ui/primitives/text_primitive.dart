import 'package:flutter/widgets.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `text` — text, опционально style (h1|h2|body|caption|mono) / bold / color.
Widget buildText(Map<String, dynamic> json, UiContext ctx) {
  final text = asText(json['text']);
  final styleName = asString(json['style']) ?? 'body';
  final bold = asBool(json['bold']) ?? false;
  final color = parseHexColor(json['color']);

  var style = switch (styleName) {
    'h1' => const TextStyle(fontSize: 28, fontWeight: FontWeight.w700, height: 1.2),
    'h2' => const TextStyle(fontSize: 22, fontWeight: FontWeight.w600, height: 1.3),
    'caption' => const TextStyle(fontSize: 12, color: Color(0xFF666666)),
    'mono' => const TextStyle(
        fontFamily: 'monospace',
        fontFamilyFallback: ['Courier New', 'monospace'],
        fontSize: 12,
      ),
    _ => const TextStyle(fontSize: 14, height: 1.4),
  };
  if (bold) {
    style = style.copyWith(fontWeight: FontWeight.bold);
  }
  if (color != null) {
    style = style.copyWith(color: color);
  }
  return Text(text, style: style);
}
