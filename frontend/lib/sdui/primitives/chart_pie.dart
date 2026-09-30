import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'chart_common.dart';

/// `chart_pie` (§8.3): `items: [{label, value, color?}]`.
///
/// Positive values become slices of a pie painted by [PieChartPainter];
/// the legend shows each label with its value. No positive item degrades
/// to a visible placeholder.
Widget buildChartPie(BuildContext context, UiNode node, RenderContext ctx) {
  final slices = <PieSliceData>[];
  final data = node.listProp('items') ?? const [];
  for (var i = 0; i < data.length; i++) {
    final map = asMap(data[i]);
    if (map == null) continue;
    final value = chartValue(map);
    if (value == null || value <= 0) continue;
    slices.add(PieSliceData(
      label: chartLabel(map),
      value: value,
      color: chartColor(i, override: parseColor(map['color'])),
    ));
  }
  if (slices.isEmpty) {
    return degradedBox(context, 'Missing items');
  }
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SizedBox(
        height: 220,
        child: CustomPaint(painter: PieChartPainter(slices)),
      ),
      const SizedBox(height: 8),
      chartLegend([
        for (final slice in slices) MapEntry(slice.label, slice.color),
      ]),
    ],
  );
}

/// One slice of the `chart_pie` plot: legend label, fill color, value.
class PieSliceData {
  const PieSliceData(
      {required this.label, required this.color, required this.value});

  final String label;
  final Color color;
  final double value;
}

/// Paints the `chart_pie` plot: one arc per slice, clockwise from 12
/// o'clock, scaled to the sum of slice values.
class PieChartPainter extends CustomPainter {
  const PieChartPainter(this.slices);

  final List<PieSliceData> slices;

  @override
  void paint(Canvas canvas, Size size) {
    final total = slices.fold<double>(0, (sum, slice) => sum + slice.value);
    if (total <= 0) return;
    final radius = math.min(size.width, size.height) / 2;
    final center = Offset(size.width / 2, size.height / 2);
    final rect = Rect.fromCircle(center: center, radius: radius);
    var start = -math.pi / 2;
    for (final slice in slices) {
      final sweep = slice.value / total * 2 * math.pi;
      canvas.drawArc(rect, start, sweep, true, Paint()..color = slice.color);
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(PieChartPainter oldDelegate) => oldDelegate.slices != slices;
}
