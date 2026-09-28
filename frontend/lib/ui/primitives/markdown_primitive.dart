import 'package:flutter/widgets.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `markdown` — text (flutter_markdown_plus MarkdownBody).
Widget buildMarkdown(Map<String, dynamic> json, UiContext ctx) {
  final text = asText(json['text']);
  if (text.isEmpty) {
    return const SizedBox.shrink();
  }
  return MarkdownBody(data: text);
}
