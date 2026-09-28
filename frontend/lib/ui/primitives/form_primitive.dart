import 'package:flutter/material.dart';

import '../ui_context.dart';
import 'primitive_helpers.dart';

/// `form` — fields + submit.
///
/// fields: `[{kind: textfield|checkbox|switch|slider, name, label, ...}]`,
/// submit: `{label, action}` → `ctx.onAction(action, {name: значение})`.
/// Кривые/неизвестные поля пропускаются, без падений.
Widget buildForm(Map<String, dynamic> json, UiContext ctx) {
  final fields = <_FieldSpec>[];
  for (final raw in asJsonList(json['fields'])) {
    final spec = _FieldSpec.parse(raw);
    if (spec != null) {
      fields.add(spec);
    }
  }
  final submit = asJsonMap(json['submit']);
  return _FormPrimitive(
    fields: fields,
    submitLabel: submit == null ? null : asText(submit['label']),
    submitAction: submit == null ? null : asString(submit['action']),
    onAction: ctx.onAction,
  );
}

enum _FieldKind { textfield, checkbox, toggle, slider }

class _FieldSpec {
  const _FieldSpec._({
    required this.kind,
    required this.name,
    required this.label,
    this.initialText = '',
    this.initialBool = false,
    this.min,
    this.max,
    this.initialSlider,
    this.multiline = false,
  });

  static _FieldSpec? parse(dynamic raw) {
    final field = asJsonMap(raw);
    if (field == null) {
      return null;
    }
    final kind = asString(field['kind']);
    final name = asString(field['name']);
    if (kind == null || name == null) {
      return null;
    }
    final label = asText(field['label']);
    return switch (kind) {
      'textfield' => _FieldSpec._(
          kind: _FieldKind.textfield,
          name: name,
          label: label,
          initialText: asText(field['value']),
          multiline: asBool(field['multiline']) ?? false,
        ),
      'checkbox' => _FieldSpec._(
          kind: _FieldKind.checkbox,
          name: name,
          label: label,
          initialBool: asBool(field['value']) ?? false,
        ),
      'switch' => _FieldSpec._(
          kind: _FieldKind.toggle,
          name: name,
          label: label,
          initialBool: asBool(field['value']) ?? false,
        ),
      'slider' => _FieldSpec._(
          kind: _FieldKind.slider,
          name: name,
          label: label,
          min: asDouble(field['min']) ?? 0,
          max: asDouble(field['max']) ?? 100,
          initialSlider: asDouble(field['value']),
        ),
      _ => null,
    };
  }

  final _FieldKind kind;
  final String name;
  final String label;
  final String initialText;
  final bool initialBool;
  final double? min;
  final double? max;
  final double? initialSlider;
  final bool multiline;
}

class _FormPrimitive extends StatefulWidget {
  const _FormPrimitive({
    required this.fields,
    required this.submitLabel,
    required this.submitAction,
    required this.onAction,
  });

  final List<_FieldSpec> fields;
  final String? submitLabel;
  final String? submitAction;
  final void Function(String action, Map<String, dynamic>? payload) onAction;

  @override
  State<_FormPrimitive> createState() => _FormPrimitiveState();
}

class _FormPrimitiveState extends State<_FormPrimitive> {
  late final Map<String, dynamic> _values;
  late final Map<String, TextEditingController> _controllers;

  @override
  void initState() {
    super.initState();
    _values = {};
    _controllers = {};
    for (final field in widget.fields) {
      switch (field.kind) {
        case _FieldKind.textfield:
          _values[field.name] = field.initialText;
          _controllers[field.name] =
              TextEditingController(text: field.initialText);
        case _FieldKind.checkbox:
        case _FieldKind.toggle:
          _values[field.name] = field.initialBool;
        case _FieldKind.slider:
          final min = field.min ?? 0;
          final max = field.max ?? 100;
          final v = field.initialSlider ?? min;
          _values[field.name] = v.clamp(min, max).toDouble();
      }
    }
  }

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _submit() {
    final action = widget.submitAction;
    if (action == null || action.isEmpty) {
      return;
    }
    widget.onAction(action, Map<String, dynamic>.from(_values));
  }

  @override
  Widget build(BuildContext context) {
    final submitLabel = widget.submitLabel;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final field in widget.fields) ...[
          _buildField(field),
          const SizedBox(height: 8),
        ],
        if (submitLabel != null)
          ElevatedButton(
            onPressed: _submit,
            child: Text(submitLabel),
          ),
      ],
    );
  }

  Widget _buildField(_FieldSpec field) {
    switch (field.kind) {
      case _FieldKind.textfield:
        return TextField(
          key: ValueKey('form-${field.name}'),
          controller: _controllers[field.name],
          maxLines: field.multiline ? 3 : 1,
          decoration: InputDecoration(
            labelText: field.label,
            border: const OutlineInputBorder(),
          ),
          onChanged: (value) => _values[field.name] = value,
        );
      case _FieldKind.checkbox:
        return CheckboxListTile(
          key: ValueKey('form-${field.name}'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          title: Text(field.label),
          value: _values[field.name] as bool? ?? false,
          onChanged: (value) {
            setState(() => _values[field.name] = value ?? false);
          },
        );
      case _FieldKind.toggle:
        return SwitchListTile(
          key: ValueKey('form-${field.name}'),
          contentPadding: EdgeInsets.zero,
          title: Text(field.label),
          value: _values[field.name] as bool? ?? false,
          onChanged: (value) {
            setState(() => _values[field.name] = value);
          },
        );
      case _FieldKind.slider:
        final min = field.min ?? 0;
        final maxRaw = field.max ?? 100;
        final max = maxRaw > min ? maxRaw : min + 1;
        final value =
            (_values[field.name] as double? ?? min).clamp(min, max).toDouble();
        return Column(
          key: ValueKey('form-${field.name}'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${field.label}: ${value.toStringAsFixed(0)}'),
            Slider(
              value: value,
              min: min,
              max: max,
              onChanged: (v) {
                setState(() => _values[field.name] = v);
              },
            ),
          ],
        );
    }
  }
}
