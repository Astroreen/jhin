import 'package:flutter/material.dart';

import '../ui_node.dart';
import '../ui_registry.dart';

/// Shared chart assets (§8.3): palette, series parsing, legend.
const List<Color> chartPalette = [
  Color(0xFF7E57C2),
  Color(0xFF26A69A),
  Color(0xFFFF7043),
  Color(0xFF42A5F5),
  Color(0xFFEC407A),
  Color(0xFF9CCC65),
];

/// Series color by index (cycling), unless the series overrides it.
Color chartColor(int index, {Color? override}) =>
    override ?? chartPalette[index % chartPalette.length];

/// Series/category label: `label`, falling back to v1's `name`.
String chartLabel(Map<String, dynamic> item) {
  final label = item['label'] ?? item['name'];
  return label is String ? label : '';
}

/// A parsed chart series: legend [label], stroke/fill [color] and its data.
class ChartSeries {
  const ChartSeries({required this.label, required this.color, required this.raw});

  final String label;
  final Color color;

  /// Parsed data points: `values` or `points` of the raw series/item map.
  final List<Object?> raw;
}

/// Parses one series/item entry's data list: `points` or `values` (or the
/// entry itself when it is a bare list). Numbers and `{x, y}` / `{label,
/// value}` maps are kept, anything else dropped (§8.3 degrade rule).
List<Object?> chartDataList(Map<String, dynamic> item) {
  final raw = item['points'] ?? item['values'] ?? item;
  if (raw is! List) return const [];
  return [
    for (final entry in raw)
      if (entry is num || entry is Map) entry,
  ];
}

/// Plots a data list as `x → y` pairs: a bare number is `y` at its index,
/// a map contributes `x`/`y` (or `label`→index / `value`) numbers.
List<Offset> chartPoints(List<Object?> data) {
  final out = <Offset>[];
  for (var i = 0; i < data.length; i++) {
    final entry = data[i];
    if (entry is num) {
      out.add(Offset(i.toDouble(), entry.toDouble()));
    } else if (entry is Map) {
      final x = entry['x'] ?? entry['label'] ?? i;
      final y = entry['y'] ?? entry['value'];
      if (y is num) {
        out.add(Offset(x is num ? x.toDouble() : i.toDouble(), y.toDouble()));
      }
    }
  }
  return out;
}

/// `label → value` of one bar/pie data entry; unvalued entries are dropped.
double? chartValue(Object? entry) {
  if (entry is num) return entry.toDouble();
  if (entry is Map) {
    final value = entry['value'];
    if (value is num) return value.toDouble();
  }
  return null;
}

/// Legend row: a color square and the series name, per entry.
Widget chartLegend(List<MapEntry<String, Color>> entries) {
  if (entries.isEmpty) return const SizedBox.shrink();
  return Wrap(
    spacing: 12,
    runSpacing: 4,
    children: [
      for (final entry in entries)
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(width: 10, height: 10, color: entry.value),
            const SizedBox(width: 4),
            Text(entry.key, style: const TextStyle(fontSize: 12)),
          ],
        ),
    ],
  );
}

/// Parses the `series` prop into [ChartSeries] entries (§8.3).
List<ChartSeries> chartSeriesList(UiNode node) {
  final out = <ChartSeries>[];
  final raw = node.listProp('series') ?? const [];
  for (var i = 0; raw.length > i; i++) {
    final map = asMap(raw[i]);
    if (map == null) continue;
    out.add(ChartSeries(
      label: chartLabel(map),
      color: chartColor(i, override: parseColor(map['color'])),
      raw: chartDataList(map),
    ));
  }
  return out;
}
