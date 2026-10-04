import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `figure` (§8.3): `shape: rectangle|circle|triangle`, `color?`,
/// `width?`, `height?`.
///
/// `shape` defaults to `rectangle`, `width`/`height` to 64 and `color` to
/// the theme's disabled color, so `{}` renders a visible grey box.
Widget buildFigure(BuildContext context, UiNode node, RenderContext ctx) {
  final color =
      parseColor(node.props['color']) ?? JhinDesignScope.materialOf(context).disabledColor;
  final width = node.numProp('width')?.toDouble() ?? 64;
  final height = node.numProp('height')?.toDouble() ?? 64;
  switch (node.stringProp('shape') ?? 'rectangle') {
    case 'circle':
      return Container(
        width: width,
        height: height,
        decoration: BoxDecoration(shape: BoxShape.circle, color: color),
      );
    case 'triangle':
      return CustomPaint(
        size: Size(width, height),
        painter: FigureTrianglePainter(color),
      );
    default:
      return Container(width: width, height: height, color: color);
  }
}

/// Paints the `triangle` figure (§8.3).
class FigureTrianglePainter extends CustomPainter {
  const FigureTrianglePainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    final path = Path()
      ..moveTo(size.width / 2, 0)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(FigureTrianglePainter oldDelegate) =>
      oldDelegate.color != color;
}
