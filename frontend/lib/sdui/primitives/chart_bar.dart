import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';
import 'chart_common.dart';

/// `chart_bar` (§8.3): `items: [{label, value, color?}]` (one series) or
/// `series: [{label?, color?, values: [{label, value}]}]` (grouped series).
///
/// A bare number in `values` is a value at its index category. Bars are
/// drawn by [BarChartPainter]; category labels render below the plot and
/// series labels in the legend. No data degrades to a visible placeholder.
Widget buildChartBar(BuildContext context, UiNode node, RenderContext ctx) {
  final categories = <String>[];
  final series = <BarSeriesData>[];

  void addSeries(String label, Color color, List<Object?> data) {
    final values = <String, double>{};
    for (var i = 0; i < data.length; i++) {
      final entry = data[i];
      final map = asMap(entry);
      double? value;
      String category;
      if (map != null) {
        value = chartValue(map);
        category = chartLabel(map);
      } else {
        value = chartValue(entry);
        category = '$i';
      }
      if (value == null) continue;
      if (!categories.contains(category)) categories.add(category);
      values[category] = value;
    }
    if (values.isEmpty) return;
    series.add(BarSeriesData(label: label, color: color, values: values));
  }

  final items = node.listProp('items');
  if (items != null && items.isNotEmpty) {
    addSeries('', chartColor(0), items);
  }
  for (final entry in chartSeriesList(node)) {
    addSeries(entry.label, entry.color, entry.raw);
  }
  if (categories.isEmpty || series.isEmpty) {
    return degradedBox(context, 'Missing items');
  }

  var max = 0.0;
  for (final entry in series) {
    for (final value in entry.values.values) {
      max = math.max(max, value);
    }
  }
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      chartLegend([
        for (final entry in series)
          if (entry.label.isNotEmpty) MapEntry(entry.label, entry.color),
      ]),
      const SizedBox(height: 8),
      SizedBox(
        height: 200,
        child: CustomPaint(
            painter: BarChartPainter(
                categories: categories, series: series, max: max)),
      ),
      Row(
        children: [
          for (final category in categories)
            Expanded(
              child: Text(
                category,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 10),
              ),
            ),
        ],
      ),
    ],
  );
}

/// One bar series of the `chart_bar` plot: legend label, fill color and
/// its `category → value` data.
class BarSeriesData {
  const BarSeriesData(
      {required this.label, required this.color, required this.values});

  final String label;
  final Color color;
  final Map<String, double> values;
}

/// Paints the `chart_bar` plot: a baseline and one grouped bar per
/// category per series, scaled to [max].
class BarChartPainter extends CustomPainter {
  const BarChartPainter(
      {required this.categories, required this.series, required this.max});

  final List<String> categories;
  final List<BarSeriesData> series;
  final double max;

  @override
  void paint(Canvas canvas, Size size) {
    final axis = Paint()
      ..color = const Color(0xFF9E9E9E)
      ..strokeWidth = 1;
    canvas.drawLine(
        Offset(0, size.height), Offset(size.width, size.height), axis);
    final scale = max <= 0 ? 0.0 : size.height / max;
    final slot = size.width / categories.length;
    final barWidth = math.max(2.0, slot / (series.length + 1));
    for (var i = 0; i < categories.length; i++) {
      final start = i * slot + (slot - barWidth * series.length) / 2;
      for (var s = 0; s < series.length; s++) {
        final value = series[s].values[categories[i]] ?? 0;
        if (value <= 0) continue;
        final height = value * scale;
        canvas.drawRect(
          Rect.fromLTWH(start + s * barWidth, size.height - height,
              barWidth, height),
          Paint()..color = series[s].color,
        );
      }
    }
  }

  @override
  bool shouldRepaint(BarChartPainter oldDelegate) =>
      oldDelegate.categories != categories ||
      oldDelegate.series != series ||
      oldDelegate.max != max;
}
