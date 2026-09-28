import 'package:flutter/widgets.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `container` — flex-контейнер: children, direction (row|column),
/// padding/gap опционально (числа, logical px).
Widget buildContainer(Map<String, dynamic> json, UiContext ctx) {
  final isRow = asString(json['direction']) == 'row';
  final padding = asDouble(json['padding']) ?? 0;
  final gap = asDouble(json['gap']) ?? 0;
  final children = buildChildWidgets(json['children'], ctx);

  final spaced = <Widget>[];
  for (var i = 0; i < children.length; i++) {
    if (i > 0 && gap > 0) {
      spaced.add(SizedBox(width: isRow ? gap : null, height: isRow ? null : gap));
    }
    spaced.add(children[i]);
  }

  return Padding(
    padding: EdgeInsets.all(padding),
    child: isRow
        ? Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: spaced,
          )
        : Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: spaced,
          ),
  );
}
