import 'package:flutter/material.dart';

import '../../design/icon_registry.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../../design/theme.dart';
import '../ui_registry.dart' show iconFor, parseColor;
import 'flex_common.dart' show parseTextDirection;

/// `icon` (§2.6): `icon` (name, required), `size`, `color`, `semanticLabel`,
/// `fill`, `weight`, `grade`, `opticalSize`, `shadows`, `textDirection` and
/// `blendMode`.
///
/// The name resolves through [kIconRegistry] only — an unknown or missing
/// name renders an empty [Icon] and logs (§2.4), never a crash. `color` is
/// the icon color (§2.6), so the universal box wrapper does not paint it as
/// a background. The variable-font props (`fill`/`weight`/`opticalSize`) and
/// `size` drop out-of-range values instead of tripping Flutter's asserts
/// (§2.4/§9: never crash on server content).
Widget buildIcon(BuildContext context, UiNode node, RenderContext ctx) {
  final name = node.stringProp('icon');
  final size = _positive(node.numProp('size')?.toDouble());
  if (name == null || name.isEmpty) {
    debugPrint('Jhin SDUI: icon node without an "icon" name');
    return Icon(null, size: size);
  }
  final data = iconFor(name);
  if (data == null) {
    return Icon(null, size: size);
  }
  return Icon(
    data,
    size: size,
    color: parseColor(node.props['color']),
    semanticLabel: node.stringProp('semanticLabel'),
    textDirection: parseTextDirection(node.stringProp('textDirection')),
    fill: _fill(node.numProp('fill')?.toDouble()),
    weight: _positive(node.numProp('weight')?.toDouble()),
    grade: _finite(node.numProp('grade')?.toDouble()),
    opticalSize: _positive(node.numProp('opticalSize')?.toDouble()),
    shadows: _shadows(node.listProp('shadows'),
        JhinDesignScope.materialOf(context).colorScheme.onSurface),
    blendMode: parseBlendMode(node.stringProp('blendMode')),
  );
}

/// The `icon`/`selectedIcon` value of `icon_button` (§2.6): an icon name
/// (resolved through [kIconRegistry]) or an inline node. Anything unknown
/// degrades to an empty [Icon] — never a crash.
Widget buildIconValue(BuildContext context, RenderContext ctx, Object? value) {
  if (value is Map) {
    return ctx.build(context, UiNode.fromJson(value));
  }
  if (value is String && value.isNotEmpty) {
    return Icon(iconFor(value));
  }
  return const Icon(null);
}

/// `fill` (§2.6): the variable-font fill, `0.0`–`1.0`. Out-of-range or
/// non-finite values drop to null (Flutter asserts on them).
double? _fill(double? value) {
  if (value == null || !value.isFinite || value < 0 || value > 1) return null;
  return value;
}

/// A strictly positive finite size/weight/opticalSize (§2.6); anything else
/// drops to null (Flutter asserts on non-positive values).
double? _positive(double? value) {
  if (value == null || !value.isFinite || value <= 0) return null;
  return value;
}

double? _finite(double? value) {
  if (value == null || !value.isFinite) return null;
  return value;
}

/// `shadows` (§2.6): the shadow-array form of the §2.1 shadow spec
/// (`{color, blur, spread, offset: [x, y]}`), one [Shadow] per entry.
/// Malformed entries are skipped — never a crash.
List<Shadow>? _shadows(List<Object?>? raw, Color fallback) {
  if (raw == null || raw.isEmpty) return null;
  final out = <Shadow>[];
  for (final item in raw) {
    final shadow = _shadowEntry(item, fallback);
    if (shadow != null) out.add(shadow);
  }
  return out.isEmpty ? null : out;
}

Shadow? _shadowEntry(Object? value, Color fallback) {
  if (value is num) {
    final blur = value.toDouble();
    if (!blur.isFinite || blur < 0) return null;
    return Shadow(blurRadius: blur, offset: Offset(0, blur));
  }
  if (value is! Map) return null;
  final map = Map<String, dynamic>.from(value);
  final blur = map['blur'];
  final offset = map['offset'];
  final dx = offset is List && offset.isNotEmpty && offset[0] is num
      ? (offset[0] as num).toDouble()
      : 0.0;
  final dy = offset is List && offset.length > 1 && offset[1] is num
      ? (offset[1] as num).toDouble()
      : 0.0;
  return Shadow(
    color: parseColor(map['color']) ?? fallback,
    blurRadius: blur is num && blur.toDouble().isFinite && blur >= 0
        ? blur.toDouble()
        : 0,
    offset: Offset(dx, dy),
  );
}

/// `blendMode` (§2.6): the [BlendMode] literal set, camelCase as in Flutter.
/// An unknown literal degrades to null (the icon's default) — §2.4.
BlendMode? parseBlendMode(String? value) {
  switch (value) {
    case 'clear':
      return BlendMode.clear;
    case 'src':
      return BlendMode.src;
    case 'dst':
      return BlendMode.dst;
    case 'srcOver':
      return BlendMode.srcOver;
    case 'dstOver':
      return BlendMode.dstOver;
    case 'srcIn':
      return BlendMode.srcIn;
    case 'dstIn':
      return BlendMode.dstIn;
    case 'srcOut':
      return BlendMode.srcOut;
    case 'dstOut':
      return BlendMode.dstOut;
    case 'srcATop':
      return BlendMode.srcATop;
    case 'dstATop':
      return BlendMode.dstATop;
    case 'xor':
      return BlendMode.xor;
    case 'plus':
      return BlendMode.plus;
    case 'modulate':
      return BlendMode.modulate;
    case 'screen':
      return BlendMode.screen;
    case 'overlay':
      return BlendMode.overlay;
    case 'darken':
      return BlendMode.darken;
    case 'lighten':
      return BlendMode.lighten;
    case 'colorDodge':
      return BlendMode.colorDodge;
    case 'colorBurn':
      return BlendMode.colorBurn;
    case 'hardLight':
      return BlendMode.hardLight;
    case 'softLight':
      return BlendMode.softLight;
    case 'difference':
      return BlendMode.difference;
    case 'exclusion':
      return BlendMode.exclusion;
    case 'multiply':
      return BlendMode.multiply;
    case 'hue':
      return BlendMode.hue;
    case 'saturation':
      return BlendMode.saturation;
    case 'color':
      return BlendMode.color;
    case 'luminosity':
      return BlendMode.luminosity;
  }
  return null;
}