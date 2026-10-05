import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

const Set<String> _fieldTypes = {
  'input',
  'textarea',
  'checkbox',
  'switch',
  'slider',
  'dropdown',
};

/// `form` (§2.6): `fields: [UiNode]`, `submit: {label, action}` with the
/// `autovalidateMode` and `onChanged` parity.
///
/// On submit the form collects the current values of its own fields and
/// posts the submit action with them merged in (via the action's `include`,
/// §8.4) — so the dispatcher validates the fields and blocks the dispatch
/// on a failing one. `onChanged` fires when any of the form's own fields
/// change. Without `fields` the node degrades to a visible placeholder;
/// without a submit `action` the submit button is disabled. Unknown
/// `autovalidateMode` literals degrade to `disabled` (§2.4).
Widget buildForm(BuildContext context, UiNode node, RenderContext ctx) {
  final rawFields = node.listProp('fields');
  if (rawFields == null || rawFields.isEmpty) {
    return degradedBox(context, 'Missing fields');
  }
  final onChanged = asMap(node.props['onChanged']);
  // The form listens to its own fields' state writes: every field change
  // dispatches the form's `onChanged` (§2.6) without leaking to fields
  // outside the form.
  final fieldCtx = onChanged == null
      ? ctx
      : RenderContext(
          state: ctx.state,
          registry: ctx.registry,
          patches: ctx.patches,
          setState: (id, value) {
            ctx.setState(id, value);
            ctx.dispatch(onChanged);
          },
          patch: ctx.patch,
          navigate: ctx.navigate,
          dispatch: ctx.dispatch,
          openStream: ctx.openStream,
          runDirectives: ctx.runDirectives,
          confirm: ctx.confirm,
          canPop: ctx.canPop,
          onBack: ctx.onBack,
          readPersisted: ctx.readPersisted,
          writePersisted: ctx.writePersisted,
        );
  final fields = buildNodeList(context, fieldCtx, rawFields);
  final submit = asMap(node.props['submit']);
  final label = submit?['label'];
  final action = asMap(submit?['action']);
  return Form(
    autovalidateMode: _autovalidateMode(node.stringProp('autovalidateMode')),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ...fields,
        if (submit != null)
          ElevatedButton(
            onPressed: action == null || node.boolProp('enabled') == false
                ? null
                : () => ctx.dispatch(_submitAction(node, action)),
            child: Text(label is String ? label : 'Submit'),
          ),
      ],
    ),
  );
}

AutovalidateMode _autovalidateMode(String? name) {
  switch (name) {
    case 'always':
      return AutovalidateMode.always;
    case 'onUserInteraction':
      return AutovalidateMode.onUserInteraction;
  }
  return AutovalidateMode.disabled;
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
