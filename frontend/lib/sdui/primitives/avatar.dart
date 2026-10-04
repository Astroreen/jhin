import 'dart:convert';

import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `avatar` (§2.6): `image` (src or dataUri), `initials`, `icon`, `color`,
/// `size` (diameter, default 40), `shape: circle|square` (default `circle`).
///
/// The content degrades image → initials → icon → empty. An unknown `shape`
/// degrades to `circle`; an undecodable `image` data URI degrades to the
/// fallback content and a failed network load to empty (§2.4 — the node
/// never throws).
Widget buildAvatar(BuildContext context, UiNode node, RenderContext ctx) {
  final theme = JhinDesignScope.materialOf(context);
  final size = node.numProp('size')?.toDouble() ?? 40;
  final square = node.stringProp('shape') == 'square';
  final color = parseColor(node.props['color']) ?? theme.colorScheme.primaryContainer;
  final ink = theme.colorScheme.onPrimaryContainer;
  final initials = node.stringProp('initials');
  final icon = iconFor(node.stringProp('icon'));

  Widget? content = _imageContent(node.stringProp('image'), size);
  content ??= initials == null || initials.isEmpty
      ? null
      : Text(
          initials,
          style: TextStyle(
            color: ink,
            fontSize: size * 0.4,
            fontWeight: FontWeight.w600,
          ),
        );
  content ??= icon == null
      ? null
      : Icon(icon, size: size * 0.6, color: ink);

  final box = Container(
    width: size,
    height: size,
    color: color,
    alignment: Alignment.center,
    child: content,
  );
  return square
      ? ClipRRect(
          borderRadius: BorderRadius.circular(size * 0.2),
          child: box,
        )
      : ClipOval(child: box);
}

/// The `image` prop as a widget: `data:` URIs decode in memory, `http(s)`
/// loads over the network with a fallback on error, anything else degrades
/// to the fallback content (§2.4).
Widget? _imageContent(String? src, double size) {
  if (src == null || src.isEmpty) return null;
  Widget fitting(Widget child) =>
      SizedBox(width: size, height: size, child: child);
  if (src.startsWith('data:')) {
    try {
      final comma = src.indexOf(',');
      if (comma < 0) return null;
      final meta = src.substring(0, comma);
      final data = src.substring(comma + 1);
      final bytes = meta.contains(';base64')
          ? base64Decode(data)
          : utf8.encode(data);
      return fitting(
        Image.memory(
          bytes,
          width: size,
          height: size,
          fit: BoxFit.cover,
          errorBuilder: (context, error, stackTrace) => const SizedBox.shrink(),
        ),
      );
    } on FormatException {
      return null;
    }
  }
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return fitting(
      Image.network(
        src,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stackTrace) => const SizedBox.shrink(),
      ),
    );
  }
  return null;
}
