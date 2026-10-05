import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../render_context.dart';
import '../ui_node.dart';

/// `progress` (§8.3): `kind: linear|circular`, `value?`.
///
/// `kind` defaults to `linear`; without `value` the indicator is
/// indeterminate. All props are optional — `{}` renders a visible
/// indeterminate bar.
///
/// T87: the indeterminate animation is a duty-cycled animation, so the
/// reduced-motion rule (§2.1) collapses it to a static empty track — the
/// `motion-safe:` behaviour of the upstream duty cycles
/// (index.css:216-220). The `indicator: pulse|ping|skeleton` modes land
/// with T92.
Widget buildProgress(BuildContext context, UiNode node, RenderContext ctx) {
  final value = node.numProp('value')?.toDouble();
  if (value != null) {
    return node.stringProp('kind') == 'circular'
        ? CircularProgressIndicator(value: value)
        : LinearProgressIndicator(value: value);
  }
  final design = JhinDesignScope.of(context);
  final animated = design.switches.statusPulseEnabled &&
      design.tokens.motion.normal > Duration.zero;
  if (animated) {
    return node.stringProp('kind') == 'circular'
        ? const CircularProgressIndicator()
        : const LinearProgressIndicator();
  }
  // Reduced motion: the static empty track (never a frozen mid-state).
  return node.stringProp('kind') == 'circular'
      ? const CircularProgressIndicator(value: 0)
      : const LinearProgressIndicator(value: 0);
}
