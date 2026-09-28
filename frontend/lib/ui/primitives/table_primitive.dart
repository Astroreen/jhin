import 'package:flutter/material.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `table` — columns `[{label}]`, rows `[[cell,...]]`.
/// Горизонтальный скролл; кривые строки паддятся/обрезаются по колонкам.
Widget buildTable(Map<String, dynamic> json, UiContext ctx) {
  final columns = <String>[];
  for (final raw in asJsonList(json['columns'])) {
    final column = asJsonMap(raw);
    columns.add(column == null ? '' : asText(column['label']));
  }
  if (columns.isEmpty) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      alignment: Alignment.center,
      child: const Text(
        'Empty table',
        style: TextStyle(fontSize: 12, color: Color(0xFF888888)),
      ),
    );
  }

  final rows = <DataRow>[];
  for (final rawRow in asJsonList(json['rows'])) {
    if (rawRow is! List) {
      continue;
    }
    final cells = <DataCell>[];
    for (var i = 0; i < columns.length; i++) {
      final cell = i < rawRow.length ? rawRow[i] : null;
      cells.add(DataCell(Text(cell == null ? '' : cell.toString())));
    }
    rows.add(DataRow(cells: cells));
  }

  return SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: DataTable(
      columns: [for (final label in columns) DataColumn(label: Text(label))],
      rows: rows,
    ),
  );
}
