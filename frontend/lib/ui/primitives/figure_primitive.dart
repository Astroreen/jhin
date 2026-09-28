import 'package:flutter/widgets.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `figure` — shape: rectangle|circle|triangle, color?, width?, height?
/// (CustomPaint). Неизвестная фигура → пусто (мягкий деград).
Widget buildFigure(Map<String, dynamic> json, UiContext ctx) {
  final shape = asString(json['shape']) ?? 'rectangle';
  final color = parseHexColor(json['color']) ?? const Color(0xFF5B6CFF);
  final width = (asDouble(json['width']) ?? 100).clamp(1, 2000).toDouble();
  final height = (asDouble(json['height']) ?? 100).clamp(1, 2000).toDouble();
  return SizedBox(
    width: width,
    height: height,
    child: CustomPaint(
      painter: _FigurePainter(shape: shape, color: color),
    ),
  );
}

class _FigurePainter extends CustomPainter {
  const _FigurePainter({required this.shape, required this.color});

  final String shape;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    switch (shape) {
      case 'rectangle':
        canvas.drawRect(Offset.zero & size, paint);
      case 'circle':
        canvas.drawCircle(size.center(Offset.zero), size.shortestSide / 2, paint);
      case 'triangle':
        final path = Path()
          ..moveTo(size.width / 2, 0)
          ..lineTo(size.width, size.height)
          ..lineTo(0, size.height)
          ..close();
        canvas.drawPath(path, paint);
      default:
        break;
    }
  }

  @override
  bool shouldRepaint(_FigurePainter oldDelegate) =>
      oldDelegate.shape != shape || oldDelegate.color != color;
}
