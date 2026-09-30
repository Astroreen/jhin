import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';

/// `spacer` (§8.3): `size?` — vertical gap, default 8 logical pixels.
Widget buildSpacer(BuildContext context, UiNode node, RenderContext ctx) =>
    SizedBox(height: node.numProp('size')?.toDouble() ?? 8);
