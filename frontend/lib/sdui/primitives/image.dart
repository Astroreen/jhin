import 'dart:convert';

import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `image` (§8.3): `src|dataUri`, `width?`, `height?`, `fit?`, `zoomable?`
/// (T104: tapping opens the zoom dialog).
///
/// `dataUri` (`data:…;base64,…`) wins over `src` (a network URL). A
/// missing source degrades to a visible placeholder; a source that fails
/// to decode or load shows the broken-image glyph. T104: `zoomable: true`
/// wraps the image in a tap target that opens the zoom dialog — the image
/// in an `InteractiveViewer` over a scrim (the upstream expandable image /
/// `ExpandedImageDialog` pair, ChatMarkdown.tsx:1539-1564); closing taps
/// the scrim or the close affordance. The dialog is client-side state —
/// the node dispatches nothing.
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

  Widget image(BuildContext context, {bool dialog = false}) {
    Widget errorBuilder(BuildContext context, Object error, StackTrace? trace) {
      return SizedBox(
        width: dialog ? 320 : width,
        height: dialog ? 240 : height,
        child: Center(
          child: Icon(iconFor('broken_image_outlined'),
              color: JhinDesignScope.materialOf(context).disabledColor),
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

  final zoomable = node.boolProp('zoomable') == true;
  if (!zoomable) return image(context);
  return GestureDetector(
    onTap: () => _openZoomDialog(context, node, image),
    child: image(context),
  );
}

/// The T104 zoom dialog: the image in an `InteractiveViewer` (pan + pinch
/// up to 8×) inside a dismissible scrim with the close affordance.
void _openZoomDialog(
    BuildContext context, UiNode node, Widget Function(BuildContext, {bool dialog}) image) {
  showDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Close image preview',
    builder: (dialogContext) => Dialog.fullscreen(
      backgroundColor:
          JhinDesignScope.materialOf(dialogContext).colorScheme.scrim.withValues(alpha: 0.85),
      child: Stack(
        children: [
          Positioned.fill(
            child: InteractiveViewer(maxScale: 8, child: Center(child: image(dialogContext, dialog: true))),
          ),
          Positioned(
            top: 16,
            right: 16,
            child: IconButton(
              icon: Icon(iconFor('close'),
                  color: JhinDesignScope.materialOf(dialogContext).colorScheme.onSurface),
              tooltip: 'Close',
              onPressed: () => Navigator.of(dialogContext).pop(),
            ),
          ),
        ],
      ),
    ),
  );
}
