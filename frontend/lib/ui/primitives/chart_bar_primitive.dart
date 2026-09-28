import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/widgets.dart';

import '../ui_context.dart';
import 'chart_helpers.dart';
import 'primitive_helpers.dart';

/// `chart_bar` — `items: [{label, value}]` (одна серия) ИЛИ
/// `series: [{name, values: [{label, value}]}]` (сгруппированные серии).
Widget buildChartBar(Map<String, dynamic> json, UiContext ctx) {
  // Имена серий и значения по меткам: label → [value per series].
  final labels = <String>[];
  final seriesNames = <String>[];
  final seriesValues = <Map<String, double>>[];

  void addSeries(String name, List<dynamic> values) {
    final byLabel = <String, double>{};
    for (final raw in values) {
      final entry = asJsonMap(raw);
      if (entry == null) {
        continue;
      }
      final value = asDouble(entry['value']);
      if (value == null) {
        continue;
      }
      final label = asText(entry['label']);
      if (!byLabel.containsKey(label) && !labels.contains(label)) {
        labels.add(label);
      }
      byLabel[label] = value;
    }
    if (byLabel.isEmpty) {
      return;
    }
    seriesNames.add(name);
    seriesValues.add(byLabel);
  }

  final items = asJsonList(json['items']);
  if (items.isNotEmpty) {
    addSeries('value', items);
  }
  for (final raw in asJsonList(json['series'])) {
    final series = asJsonMap(raw);
    if (series == null) {
      continue;
    }
    addSeries(asText(series['name']), asJsonList(series['values']));
  }

  if (labels.isEmpty || seriesValues.isEmpty) {
    return chartFallback();
  }

  final groups = <BarChartGroupData>[];
  for (var i = 0; i < labels.length; i++) {
    final rods = <BarChartRodData>[];
    for (var s = 0; s < seriesValues.length; s++) {
      rods.add(
        BarChartRodData(
          toY: seriesValues[s][labels[i]] ?? 0,
          color: chartColor(s),
          width: seriesValues.length > 1 ? 10 : 18,
        ),
      );
    }
    groups.add(BarChartGroupData(x: i, barRods: rods));
  }

  final legend = <MapEntry<String, Color>>[
    for (var s = 0; s < seriesNames.length; s++)
      MapEntry(seriesNames[s], chartColor(s)),
  ];

  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      buildChartLegend(legend),
      SizedBox(
        height: 200,
        child: BarChart(
          BarChartData(
            barGroups: groups,
            titlesData: FlTitlesData(
              topTitles: const AxisTitles(),
              rightTitles: const AxisTitles(),
              leftTitles: const AxisTitles(
                sideTitles: SideTitles(showTitles: true, reservedSize: 36),
              ),
              bottomTitles: AxisTitles(
                sideTitles: SideTitles(
                  showTitles: true,
                  reservedSize: 28,
                  getTitlesWidget: (value, meta) {
                    final i = value.toInt();
                    if (i < 0 || i >= labels.length) {
                      return const SizedBox.shrink();
                    }
                    return Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        labels[i],
                        style: const TextStyle(fontSize: 10),
                        overflow: TextOverflow.ellipsis,
                      ),
                    );
                  },
                ),
              ),
            ),
          ),
          duration: Duration.zero,
        ),
      ),
    ],
  );
}
