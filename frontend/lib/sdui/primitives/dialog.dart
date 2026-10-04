import 'package:flutter/material.dart';

import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `dialog` (§2.6): `title` (string or node), `content` (node), `actions`
/// (node array).
///
/// An AlertDialog-shaped surface so dialogs are server-authored: the
/// title/content slots and the action buttons render in place, and each
/// action node dispatches through its own handler (a `button` carrying an
/// `action`, §2.4). Every slot is optional — a title with actions and no
/// content is a legal confirm shape. The `dialog` directive (§4) opens this
/// shape modally; an unknown directive `kind` degrades to a `card` render of
/// the content (§2.4).
Widget buildDialog(BuildContext context, UiNode node, RenderContext ctx) {
  final titleProp = node.props['title'];
  final Widget? title = titleProp == null
      ? null
      : titleProp is String
          ? Text(titleProp)
          : buildChildProp(context, ctx, titleProp);
  final content = buildChildProp(context, ctx, node.props['content']);
  final actions = <Widget>[];
  for (final raw in node.listProp('actions') ?? const <Object?>[]) {
    final widget = buildChildProp(context, ctx, raw);
    if (widget != null) actions.add(widget);
  }
  return AlertDialog(
    title: title,
    content: content,
    actions: actions.isEmpty ? null : actions,
  );
}
