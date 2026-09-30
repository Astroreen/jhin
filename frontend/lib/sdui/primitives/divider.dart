import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';

/// `divider` (§8.3): no props — a hairline rule.
Widget buildDivider(BuildContext context, UiNode node, RenderContext ctx) =>
    const Divider(height: 1);
