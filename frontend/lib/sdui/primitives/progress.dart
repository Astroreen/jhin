import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';

/// `progress` (§8.3): `kind: linear|circular`, `value?`.
///
/// `kind` defaults to `linear`; without `value` the indicator is
/// indeterminate. All props are optional — `{}` renders a visible
/// indeterminate bar.
Widget buildProgress(BuildContext context, UiNode node, RenderContext ctx) {
  final value = node.numProp('value')?.toDouble();
  return node.stringProp('kind') == 'circular'
      ? CircularProgressIndicator(value: value)
      : LinearProgressIndicator(value: value);
}
