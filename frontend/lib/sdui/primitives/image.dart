import 'dart:convert';

import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `image` (§8.3): `src|dataUri`, `width?`, `height?`, `fit?`.
///
/// `dataUri` (`data:…;base64,…`) wins over `src` (a network URL). A
/// missing source degrades to a visible placeholder; a source that fails
/// to decode or load shows the broken-image glyph.
Widget buildImage(BuildContext context, UiNode node, RenderContext ctx) {
  final width = node.numProp('width')?.toDouble();
  final height = node.numProp('height')?.toDouble();
  final fit = switch (node.stringProp('fit')) {
    'cover' => BoxFit.cover,
    'fill' => BoxFit.fill,
    'fitWidth' => BoxFit.fitWidth,
    'fitHeight' => BoxFit.fitHeight,
    _ => BoxFit.contain,
  };
  Widget errorBuilder(BuildContext context, Object error, StackTrace? trace) {
    return SizedBox(
      width: width,
      height: height,
      child: Center(
        child: Icon(iconFor('broken_image_outlined'),
            color: Theme.of(context).disabledColor),
      ),
    );
  }

  final dataUri = node.stringProp('dataUri');
  if (dataUri != null && dataUri.startsWith('data:')) {
    final comma = dataUri.indexOf(',');
    if (comma > 0) {
      try {
        final bytes = base64Decode(dataUri.substring(comma + 1));
        return Image.memory(bytes, width: width, height: height, fit: fit);
      } catch (_) {}
    }
  }
  final src = node.stringProp('src');
  if (src == null || src.isEmpty) {
    return degradedBox(context, 'Missing src');
  }
  return Image.network(src,
      width: width, height: height, fit: fit, errorBuilder: errorBuilder);
}
