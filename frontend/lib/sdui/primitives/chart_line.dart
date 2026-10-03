import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'chart_common.dart';

/// `chart_line` (§8.3): `series: [{label?, color?, points|[values]}]`.
///
/// Points are bare numbers (`y` at `x = index`) or `{x, y}` maps. Each
/// series is drawn as a polyline by [LineChartPainter] with its label in
/// the legend. No series with data degrades to a visible placeholder.
Widget buildChartLine(BuildContext context, UiNode node, RenderContext ctx) {
  final series = [
    for (final entry in chartSeriesList(node))
      LineChartData(
        label: entry.label,
        color: entry.color,
        points: chartPoints(entry.raw),
      ),
  ];
  if (series.every((line) => line.points.isEmpty)) {
    return degradedBox(context, 'Missing series');
  }
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      chartLegend([
        for (final line in series) MapEntry(line.label, line.color),
      ]),
      SizedBox(height: JhinDesignScope.of(context).tokens.spacing.sm),
      SizedBox(
        height: JhinDesignScope.of(context).tokens.chartHeight,
        child: CustomPaint(painter: LineChartPainter(series)),
      ),
    ],
  );
}

/// One line of the `chart_line` plot: legend label, stroke color, points.
class LineChartData {
  const LineChartData(
      {required this.label, required this.color, required this.points});

  final String label;
  final Color color;
  final List<Offset> points;
}

/// Paints the `chart_line` plot: axes and one polyline per series,
/// normalized over the combined data bounds.
class LineChartPainter extends CustomPainter {
  const LineChartPainter(this.series);

  final List<LineChartData> series;

  @override
  void paint(Canvas canvas, Size size) {
    final axis = Paint()
      ..color = const Color(0xFF9E9E9E)
      ..strokeWidth = 1;
    canvas.drawLine(Offset.zero, Offset(0, size.height), axis);
    canvas.drawLine(
        Offset(0, size.height), Offset(size.width, size.height), axis);

    var minX = 0.0, maxX = 1.0, minY = 0.0, maxY = 1.0;
    var first = true;
    for (final line in series) {
      for (final point in line.points) {
        if (first) {
          minX = maxX = point.dx;
          minY = maxY = point.dy;
          first = false;
        } else {
          minX = math.min(minX, point.dx);
          maxX = math.max(maxX, point.dx);
          minY = math.min(minY, point.dy);
          maxY = math.max(maxY, point.dy);
        }
      }
    }
    final spanX = maxX - minX == 0 ? 1.0 : maxX - minX;
    final spanY = maxY - minY == 0 ? 1.0 : maxY - minY;

    Offset toCanvas(Offset point) => Offset(
          (point.dx - minX) / spanX * size.width,
          size.height - (point.dy - minY) / spanY * size.height,
        );

    for (final line in series) {
      if (line.points.isEmpty) continue;
      final paint = Paint()
        ..color = line.color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke;
      if (line.points.length == 1) {
        canvas.drawCircle(
            toCanvas(line.points.single), 3, Paint()..color = line.color);
        continue;
      }
      final path = Path();
      for (var i = 0; i < line.points.length; i++) {
        final point = toCanvas(line.points[i]);
        if (i == 0) {
          path.moveTo(point.dx, point.dy);
        } else {
          path.lineTo(point.dx, point.dy);
        }
      }
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(LineChartPainter oldDelegate) =>
      oldDelegate.series != series;
}
