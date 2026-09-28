import 'package:flutter/widgets.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `list` — items: массив дочерних UI-узлов ИЛИ строк; прокручиваемый
/// (до ~300px, далее скролл).
Widget buildList(Map<String, dynamic> json, UiContext ctx) {
  final children = buildChildWidgets(json['items'], ctx);
  return ConstrainedBox(
    constraints: const BoxConstraints(maxHeight: 300),
    child: ListView(
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      physics: const ClampingScrollPhysics(),
      children: children,
    ),
  );
}
