import 'package:flutter/material.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `dropdown` — items `[{label, value}]`, value? (начальный выбор), action.
/// Выбор → `ctx.onAction(action, {"value": <оригинальное value>})`.
Widget buildDropdown(Map<String, dynamic> json, UiContext ctx) {
  final items = <_DropItem>[];
  for (final raw in asJsonList(json['items'])) {
    final item = asJsonMap(raw);
    if (item == null) {
      continue;
    }
    final label = asText(item['label']);
    final value = item['value'];
    if (value == null) {
      continue;
    }
    items.add(_DropItem(label: label, value: value));
  }
  final initial = asString(json['value']) ?? asText(json['value']);
  final action = asString(json['action']);
  return _DropdownPrimitive(
    items: items,
    initial: initial,
    action: action,
    onAction: ctx.onAction,
  );
}

class _DropItem {
  const _DropItem({required this.label, required this.value});

  final String label;

  /// Оригинальное JSON-значение (уходит в payload как есть).
  final dynamic value;

  /// Строковый ключ для DropdownButton (value → toString()).
  String get key => value.toString();
}

class _DropdownPrimitive extends StatefulWidget {
  const _DropdownPrimitive({
    required this.items,
    required this.initial,
    required this.action,
    required this.onAction,
  });

  final List<_DropItem> items;
  final String initial;
  final String? action;
  final void Function(String action, Map<String, dynamic>? payload) onAction;

  @override
  State<_DropdownPrimitive> createState() => _DropdownPrimitiveState();
}

class _DropdownPrimitiveState extends State<_DropdownPrimitive> {
  late String? _selected;

  @override
  void initState() {
    super.initState();
    final hasInitial =
        widget.items.any((item) => item.key == widget.initial);
    _selected = hasInitial ? widget.initial : null;
  }

  @override
  Widget build(BuildContext context) {
    if (widget.items.isEmpty) {
      return const Text('—');
    }
    return DropdownButton<String>(
      value: _selected,
      isExpanded: true,
      hint: const Text('—'),
      items: [
        for (final item in widget.items)
          DropdownMenuItem<String>(
            value: item.key,
            child: Text(item.label),
          ),
      ],
      onChanged: (key) {
        if (key == null) {
          return;
        }
        setState(() => _selected = key);
        final action = widget.action;
        if (action == null || action.isEmpty) {
          return;
        }
        final match = widget.items.where((item) => item.key == key);
        final value = match.isEmpty ? key : match.first.value;
        widget.onAction(action, {'value': value});
      },
    );
  }
}
