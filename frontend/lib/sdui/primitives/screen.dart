import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `screen` (§8.3): `title?`, `appBar?`, `body`, `floatingAction?`.
///
/// A missing `body` degrades to a visible placeholder — the rest of the
/// node (app bar, floating action) still renders.
Widget buildScreen(BuildContext context, UiNode node, RenderContext ctx) {
  final title = node.stringProp('title');
  final appBar = node.props['appBar'];
  final body = node.props['body'];
  final floatingAction = node.props['floatingAction'];
  return Scaffold(
    appBar: (title != null && title.isNotEmpty) || appBar is Map
        ? AppBar(
            title: title != null && title.isNotEmpty
                ? Text(title)
                : ctx.build(context, UiNode.fromJson(appBar)),
          )
        : null,
    body: SafeArea(
      child: body == null
          ? degradedBox(context, 'Missing body')
          : ctx.build(context, UiNode.fromJson(body)),
    ),
    floatingActionButton: floatingAction == null
        ? null
        : ctx.build(context, UiNode.fromJson(floatingAction)),
  );
}
