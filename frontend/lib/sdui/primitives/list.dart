import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `list` (§8.3): `items: [UiNode|string]`, `maxHeight?`.
///
/// A string item is a `text` node (§8.3). With `maxHeight` the column
/// scrolls inside that height. Missing or empty `items` degrades to a
/// visible placeholder.
Widget buildList(BuildContext context, UiNode node, RenderContext ctx) {
  final items = node.listProp('items');
  if (items == null || items.isEmpty) {
    return degradedBox(context, 'Missing items');
  }
  final column = Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: buildNodeList(context, ctx, items),
  );
  final maxHeight = node.numProp('maxHeight')?.toDouble();
  if (maxHeight == null) return column;
  return ConstrainedBox(
    constraints: BoxConstraints(maxHeight: maxHeight),
    child: SingleChildScrollView(child: column),
  );
}
