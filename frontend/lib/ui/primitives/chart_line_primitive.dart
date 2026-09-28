import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/widgets.dart';

import '../ui_context.dart';
import 'chart_helpers.dart';
import 'primitive_helpers.dart';

/// `chart_line` — series `[{name, points: [{x, y}]}]` (fl_chart LineChart).
Widget buildChartLine(Map<String, dynamic> json, UiContext ctx) {
  final bars = <LineChartBarData>[];
  final legend = <MapEntry<String, Color>>[];

  var index = 0;
  for (final raw in asJsonList(json['series'])) {
    final series = asJsonMap(raw);
    if (series == null) {
      continue;
    }
    final spots = <FlSpot>[];
    for (final rawPoint in asJsonList(series['points'])) {
      final point = asJsonMap(rawPoint);
      if (point == null) {
        continue;
      }
      final x = asDouble(point['x']);
      final y = asDouble(point['y']);
      if (x == null || y == null) {
        continue;
      }
      spots.add(FlSpot(x, y));
    }
    if (spots.isEmpty) {
      continue;
    }
    final color = chartColor(index, override: parseHexColor(series['color']));
    bars.add(LineChartBarData(spots: spots, color: color));
    legend.add(MapEntry(asText(series['name']), color));
    index++;
  }

  if (bars.isEmpty) {
    return chartFallback();
  }

  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      buildChartLegend(legend),
      SizedBox(
        height: 200,
        child: LineChart(
          LineChartData(
            lineBarsData: bars,
            titlesData: const FlTitlesData(show: false),
            gridData: const FlGridData(show: true),
          ),
          duration: Duration.zero,
        ),
      ),
    ],
  );
}
