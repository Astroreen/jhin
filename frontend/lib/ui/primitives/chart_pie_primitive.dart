import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/widgets.dart';

import '../ui_context.dart';
import 'chart_helpers.dart';
import 'primitive_helpers.dart';

/// `chart_pie` — items `[{label, value, color?}]` (fl_chart PieChart).
Widget buildChartPie(Map<String, dynamic> json, UiContext ctx) {
  final sections = <PieChartSectionData>[];
  final legend = <MapEntry<String, Color>>[];

  var index = 0;
  for (final raw in asJsonList(json['items'])) {
    final item = asJsonMap(raw);
    if (item == null) {
      continue;
    }
    final value = asDouble(item['value']);
    if (value == null || value <= 0) {
      continue;
    }
    final label = asText(item['label']);
    final color = chartColor(index, override: parseHexColor(item['color']));
    sections.add(
      PieChartSectionData(
        value: value,
        color: color,
        title: label,
        radius: 50,
        titleStyle: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: Color(0xFFFFFFFF),
        ),
      ),
    );
    legend.add(MapEntry(label, color));
    index++;
  }

  if (sections.isEmpty) {
    return chartFallback();
  }

  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SizedBox(
        height: 220,
        child: PieChart(
          PieChartData(sections: sections),
          duration: Duration.zero,
        ),
      ),
      const SizedBox(height: 8),
      buildChartLegend(legend),
    ],
  );
}
