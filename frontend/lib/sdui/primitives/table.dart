import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `table` (§8.3): `columns: [{label, width?}]`, `rows: [[UiNode|string]]`.
///
/// `width` is a flex weight (default 1). A cell may be a node or a string
/// (`text`). Missing `columns` degrades to a visible placeholder; a
/// missing `rows` list renders the header only.
Widget buildTable(BuildContext context, UiNode node, RenderContext ctx) {
  final columns = node.listProp('columns');
  if (columns == null || columns.isEmpty) {
    return degradedBox(context, 'Missing columns');
  }
  final rows = node.listProp('rows') ?? const [];
  final flexes = <int>[];
  final headers = <String>[];
  for (final raw in columns) {
    final map = asMap(raw);
    headers.add('${map?['label'] ?? ''}');
    final width = map?['width'];
    flexes.add(width is num && width > 0 ? width.round() : 1);
  }
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        children: [
          for (var i = 0; i < headers.length; i++)
            Expanded(
              flex: i < flexes.length ? flexes[i] : 1,
              child: Text(headers[i],
                  style: const TextStyle(fontWeight: FontWeight.bold)),
            ),
        ],
      ),
      const Divider(height: 1),
      for (final raw in rows)
        if (raw is List)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < raw.length; i++)
                Expanded(
                  flex: i < flexes.length ? flexes[i] : 1,
                  child: ctx.build(context, UiNode.fromJson(raw[i])),
                ),
            ],
          ),
    ],
  );
}
