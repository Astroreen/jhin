import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

const Set<String> _fieldTypes = {
  'input',
  'checkbox',
  'switch',
  'slider',
  'dropdown',
};

/// `form` (§8.3): `fields: [UiNode]`, `submit: {label, action}`.
///
/// On submit the form collects the current values of its own fields and
/// posts the submit action with them merged in (via the action's `include`,
/// §8.4) — so the dispatcher validates the fields and blocks the dispatch
/// on a failing one. Without `fields` the node degrades to a visible
/// placeholder; without a submit `action` the submit button is disabled.
Widget buildForm(BuildContext context, UiNode node, RenderContext ctx) {
  final rawFields = node.listProp('fields');
  if (rawFields == null || rawFields.isEmpty) {
    return degradedBox(context, 'Missing fields');
  }
  final fields = buildNodeList(context, ctx, rawFields);
  final submit = asMap(node.props['submit']);
  final label = submit?['label'];
  final action = asMap(submit?['action']);
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ...fields,
      if (submit != null)
        ElevatedButton(
          onPressed: action == null
              ? null
              : () => ctx.dispatch(_submitAction(node, action)),
          child: Text(label is String ? label : 'Submit'),
        ),
    ],
  );
}

/// The submit action with the form's own field ids appended to `include`
/// (existing includes win), so `ActionDispatcher` merges their current
/// typed values into the posted payload (§8.4).
Map<String, dynamic> _submitAction(UiNode form, Map<String, dynamic> action) {
  final include = <String>[
    if (action['include'] is List)
      for (final item in action['include'] as List)
        if (item is String) item,
  ];
  for (final raw in form.listProp('fields') ?? const []) {
    for (final child in UiNode.fromJson(raw).flatten()) {
      final id = child.id;
      if (id != null && _fieldTypes.contains(child.type) && !include.contains(id)) {
        include.add(id);
      }
    }
  }
  return {
    ...action,
    if (include.isNotEmpty) 'include': include,
  };
}
