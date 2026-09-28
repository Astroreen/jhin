import 'dart:convert';

import 'package:flutter/material.dart';

/// T30 ExtensionPoint: рендер `structured` content tool-результатов.
///
/// T29: сырой JSON в моноширинном блоке.
/// T30 заменяет тело на server-driven UI (реестр примитивов: dropdown, list,
/// card, table, charts…) — экраны и store НЕ трогает, только этот файл.
Widget buildStructured(dynamic structured) {
  if (structured == null) {
    return const SizedBox.shrink();
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
