import 'package:flutter/widgets.dart';

/// Общие ассеты chart-примитивов: палитра и легенда.
const List<Color> kChartPalette = [
  Color(0xFF5B6CFF),
  Color(0xFFFF6B6B),
  Color(0xFF4ECB71),
  Color(0xFFFFA94D),
  Color(0xFF9775FA),
  Color(0xFF22B8CF),
];

/// Цвет серии по индексу (с зацикливанием).
Color chartColor(int index, {Color? override}) =>
    override ?? kChartPalette[index % kChartPalette.length];

/// Простая легенда: цветной квадрат + имя серии.
Widget buildChartLegend(List<MapEntry<String, Color>> entries) {
  if (entries.isEmpty) {
    return const SizedBox.shrink();
  }
  return Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Wrap(
      spacing: 12,
      runSpacing: 4,
      children: [
        for (final entry in entries)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 10,
                height: 10,
                color: entry.value,
              ),
              const SizedBox(width: 4),
              Text(entry.key, style: const TextStyle(fontSize: 12)),
            ],
          ),
      ],
    ),
  );
}

/// Заглушка для пустых/сломанных данных графика.
Widget chartFallback([String message = 'No chart data']) {
  return Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    alignment: Alignment.center,
    child: Text(message, style: const TextStyle(fontSize: 12, color: Color(0xFF888888))),
  );
}
